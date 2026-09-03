/**
 * Handoff broker: the pi side of proxied custom-tool calls.
 *
 * Observer mode used to end the CLI turn the moment the model called a custom
 * pi tool: deny the permission, send `interrupt`, let the CLI exit, run the
 * tool in pi, then `--resume` a NEW process with the result pasted in as user
 * text. Every one of those restarts rebuilt the CLI's system prompt — and
 * Claude Code snapshots `git status`, recent commits and the branch into it,
 * so a commit or a branch rename between two processes re-billed the entire
 * context as cache WRITE (measured 2026-09-01: 64k, 106k and 190k tokens in
 * one session; 1.87M across three sessions that day). The restart also left
 * "tool use was rejected" / "[Request interrupted]" / "No response requested."
 * filler in the CLI transcript on every custom tool call.
 *
 * Now the permission is ALLOWED and the CLI calls `tools/call` on the
 * schema-only MCP server (`mcp-schema-server.cjs`), which forwards the call
 * here over a local socket and blocks until pi has executed the tool. The CLI
 * process never exits mid-turn, its cached prefix stays intact, and its
 * transcript records a real tool_result.
 *
 * Wire (NDJSON, one request per connection):
 *   server → broker  {"type":"call","session":<cliSessionId>,
 *                     "toolUseId":…,"name":…,"arguments":{…}}
 *   broker → server  {"type":"result","content":[…],"isError":bool}
 *
 * Routing is by CLI session id — the config file each CLI process is spawned
 * with names its own session — so concurrent sessions in one pi process
 * never see each other's calls. A call with no registered target is answered
 * with an error immediately: the CLI must never hang on a tool pi will not
 * execute.
 */

import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

/** One MCP `tools/call` waiting for pi's result. */
export interface HandoffCall {
  toolUseId: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Answer the CLI. Safe to call once; later calls are ignored. */
  respond(result: HandoffResult): void;
}

/** MCP tool result shape the schema server relays verbatim. */
export interface HandoffResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export interface HandoffTarget {
  onHandoffCall(call: HandoffCall): void;
}

const targets = new Map<string, HandoffTarget>();

export function registerHandoffTarget(
  cliSessionId: string,
  target: HandoffTarget,
): void {
  targets.set(cliSessionId, target);
}

export function unregisterHandoffTarget(
  cliSessionId: string,
  target?: HandoffTarget,
): void {
  if (target && targets.get(cliSessionId) !== target) return;
  targets.delete(cliSessionId);
}

/** Text result helper for error answers. */
export function errorResult(message: string): HandoffResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export const NO_TARGET_MESSAGE =
  "pi is not attached to this Claude session; the tool was not executed.";

/**
 * Route one incoming call. Exported for tests and for the socket server
 * below; `respond` is wired by the caller.
 */
export function dispatchHandoffCall(
  session: string,
  call: HandoffCall,
): boolean {
  const target = targets.get(session);
  if (!target) {
    call.respond(errorResult(NO_TARGET_MESSAGE));
    return false;
  }
  try {
    target.onHandoffCall(call);
  } catch (err) {
    call.respond(
      errorResult(
        `pi failed to accept the tool call: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return false;
  }
  return true;
}

let server: Server | undefined;
let socketPath: string | undefined;
let starting: Promise<string> | undefined;

/** Per-process socket path: a unix socket, or a named pipe on Windows. */
export function defaultSocketPath(): string {
  const name = `pi-claude-handoff-${process.pid}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${name}`
    : join(tmpdir(), `${name}.sock`);
}

function parseIncoming(line: string):
  | {
      session: string;
      toolUseId: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | undefined {
  try {
    const msg = JSON.parse(line);
    if (!msg || msg.type !== "call") return undefined;
    if (typeof msg.session !== "string" || typeof msg.name !== "string")
      return undefined;
    const args =
      msg.arguments &&
      typeof msg.arguments === "object" &&
      !Array.isArray(msg.arguments)
        ? (msg.arguments as Record<string, unknown>)
        : {};
    return {
      session: msg.session,
      toolUseId: typeof msg.toolUseId === "string" ? msg.toolUseId : "",
      name: msg.name,
      arguments: args,
    };
  } catch {
    return undefined;
  }
}

function handleConnection(socket: Socket): void {
  let buffer = "";
  let handled = false;
  const finish = (result: HandoffResult) => {
    if (handled) return;
    handled = true;
    try {
      socket.end(JSON.stringify({ type: "result", ...result }) + "\n");
    } catch {
      /* server went away — nothing to answer */
    }
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    if (handled) return;
    buffer += chunk;
    const nl = buffer.indexOf("\n");
    if (nl === -1) return;
    const line = buffer.slice(0, nl);
    buffer = "";
    const incoming = parseIncoming(line);
    if (!incoming) {
      finish(errorResult("malformed handoff request"));
      return;
    }
    dispatchHandoffCall(incoming.session, {
      toolUseId: incoming.toolUseId,
      name: incoming.name,
      arguments: incoming.arguments,
      respond: finish,
    });
  });
  socket.on("error", () => {
    handled = true;
  });
}

/**
 * Start the socket server once. Resolves to the socket path the MCP config
 * must carry. Rejects if the socket cannot be bound — callers fall back to
 * the interrupt-and-resume handoff.
 */
export function startHandoffBroker(
  path = defaultSocketPath(),
): Promise<string> {
  if (socketPath) return Promise.resolve(socketPath);
  if (starting) return starting;
  starting = new Promise<string>((resolve, reject) => {
    if (process.platform !== "win32") {
      try {
        unlinkSync(path);
      } catch {
        /* nothing stale to remove */
      }
    }
    const srv = createServer(handleConnection);
    srv.on("error", (err) => {
      starting = undefined;
      reject(err);
    });
    srv.listen(path, () => {
      server = srv;
      socketPath = path;
      // The broker must never hold pi's process open on its own.
      srv.unref();
      resolve(path);
    });
  });
  return starting;
}

/** Current socket path, if the broker is up. */
export function handoffSocketPath(): string | undefined {
  return socketPath;
}

/** Stop the server and remove the socket file. Registered on process exit. */
export function stopHandoffBroker(): void {
  const path = socketPath;
  const srv = server;
  server = undefined;
  socketPath = undefined;
  starting = undefined;
  targets.clear();
  try {
    srv?.close();
  } catch {
    /* already closed */
  }
  if (path && process.platform !== "win32") {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}

/** Test seam. */
export function resetHandoffBrokerForTests(): void {
  stopHandoffBroker();
}
