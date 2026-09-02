/**
 * The schema server process end to end: initialize, tools/list, and a
 * tools/call proxied over the handoff socket to a fake pi (this test), plus
 * the session-less form that answers tools/call with an error.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "src", "mcp-schema-server.cjs");

function rpc(proc: ChildProcess) {
  const pending = new Map<number, (msg: any) => void>();
  let buf = "";
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
      } catch {
        /* ignore */
      }
    }
  });
  let nextId = 1;
  return (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
}

describe("mcp-schema-server.cjs", () => {
  let dir: string;
  let schemaPath: string;
  let broker: Server | undefined;
  let sockPath: string;
  const seen: any[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pcc-schema-"));
    schemaPath = join(dir, "schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify([
        {
          name: "search",
          description: "Search",
          inputSchema: { type: "object", properties: {} },
        },
      ]),
    );
    if (process.platform !== "win32") {
      sockPath = join(dir, "broker.sock");
      broker = createServer((socket) => {
        let b = "";
        socket.setEncoding("utf8");
        socket.on("data", (d: string) => {
          b += d;
          if (!b.includes("\n")) return;
          const req = JSON.parse(b.slice(0, b.indexOf("\n")));
          seen.push(req);
          socket.end(
            JSON.stringify({
              type: "result",
              content: [
                { type: "text", text: `pi ran ${req.name} for ${req.session}` },
              ],
            }) + "\n",
          );
        });
      });
      await new Promise<void>((r) => broker!.listen(sockPath, r));
    }
  });

  afterAll(() => {
    broker?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves initialize and tools/list from the schema file", async () => {
    const proc = spawn("node", [SERVER, schemaPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const call = rpc(proc);
      const init = await call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
      });
      expect(init.result.serverInfo.name).toBe("custom-tools");
      const list = await call("tools/list");
      expect(list.result.tools.map((t: any) => t.name)).toEqual(["search"]);
      // Unknown requests are answered, never left hanging.
      const ping = await call("prompts/list");
      expect(ping.error.code).toBe(-32601);
    } finally {
      proc.kill("SIGKILL");
    }
  });

  it("without a socket, tools/call is an error result (pi is not attached)", async () => {
    const proc = spawn("node", [SERVER, schemaPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const call = rpc(proc);
      const res = await call("tools/call", { name: "search", arguments: {} });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toMatch(/not attached/);
    } finally {
      proc.kill("SIGKILL");
    }
  });

  it("with a socket, tools/call is forwarded to pi with the session and tool_use id, and the result relayed", async () => {
    if (process.platform === "win32") return;
    const proc = spawn("node", [SERVER, schemaPath, sockPath, "cli-sess-42"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const call = rpc(proc);
      const res = await call("tools/call", {
        name: "search",
        arguments: { q: "x" },
        _meta: { "claudecode/toolUseId": "toolu_9" },
      });
      expect(res.result).toEqual({
        content: [{ type: "text", text: "pi ran search for cli-sess-42" }],
        isError: false,
      });
      expect(seen[seen.length - 1]).toEqual({
        type: "call",
        session: "cli-sess-42",
        toolUseId: "toolu_9",
        name: "search",
        arguments: { q: "x" },
      });
    } finally {
      proc.kill("SIGKILL");
    }
  });

  it("a dead socket yields an error result rather than a hang", async () => {
    if (process.platform === "win32") return;
    const proc = spawn(
      "node",
      [SERVER, schemaPath, join(dir, "nope.sock"), "cli-x"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    try {
      const call = rpc(proc);
      const res = await call("tools/call", { name: "search", arguments: {} });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toMatch(/not reachable/);
    } finally {
      proc.kill("SIGKILL");
    }
  });
});
