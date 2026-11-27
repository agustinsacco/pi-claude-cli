/**
 * Claude must not answer a pi turn without pi's tools. On a loaded machine the
 * CLI's MCP client gave up on the schema server (5 s connect, 30 s first-turn
 * hold), the init event reported `custom-tools` as failed, and the model
 * answered without pi's tools. Captured on claude 2.1.327 with a server that took 40 s to start:
 * defaults → `failed` and no tools; raised timeouts → `connected`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("cross-spawn", () => ({
  default: vi.fn(() => {
    const proc = new EventEmitter();
    (proc as any).stdin = { write: vi.fn(), end: vi.fn() };
    (proc as any).stdout = new PassThrough();
    (proc as any).stderr = new EventEmitter();
    (proc as any).killed = false;
    (proc as any).exitCode = null;
    (proc as any).kill = vi.fn(() => ((proc as any).killed = true));
    (proc as any).pid = 4243;
    return proc;
  }),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("2.1.327 (Claude Code)")),
}));

const { MockStream } = vi.hoisted(() => {
  const MockStream: any = vi.fn(function (this: any) {
    const events: any[] = [];
    this.push = vi.fn((event: any) => events.push(event));
    this.end = vi.fn();
    this._events = events;
  });
  return { MockStream };
});

vi.mock("@earendil-works/pi-ai", async () => ({
  ...(await vi.importActual<any>("@earendil-works/pi-ai")),
  createAssistantMessageEventStream: vi.fn(() => new MockStream()),
  calculateCost: vi.fn(),
}));

import spawn from "cross-spawn";
import { streamViaCli } from "../src/provider";
import { resetCliProcessesForTests } from "../src/cli-process";
import { resetHandoffBrokerForTests } from "../src/handoff-broker";
import {
  spawnClaude,
  cleanupSystemPromptFile,
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_TIMEOUT_MS,
} from "../src/process-manager";

const model = {
  id: "claude-opus-5-5",
  api: "pi-claude-cli",
  provider: "pi-claude-cli",
  reasoning: true,
  input: ["text"],
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
} as any;

const line = (o: any) => JSON.stringify(o) + "\n";
const ev = (event: any) => line({ type: "stream_event", event });
const init = (status?: string) =>
  line({
    type: "system",
    subtype: "init",
    tools: status === "connected" ? ["mcp__custom-tools__fetch_content"] : [],
    mcp_servers:
      status === undefined
        ? []
        : [{ name: "custom-tools", status, source: "dynamic" }],
  });
const reply = (t: string) =>
  ev({ type: "message_start", message: { usage: { input_tokens: 1 } } }) +
  ev({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }) +
  ev({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: t },
  }) +
  ev({ type: "content_block_stop", index: 0 }) +
  ev({ type: "message_delta", delta: { stop_reason: "end_turn" } }) +
  ev({ type: "message_stop" }) +
  line({ type: "result", subtype: "success", is_error: false });

const procAt = (i: number) => (spawn as any).mock.results[i].value;
const argsAt = (i: number) => (spawn as any).mock.calls[i][1] as string[];
const events = (n = 0) => MockStream.mock.instances[n]._events as any[];
const done = (n = 0) => events(n).find((e) => e.type === "done");
const failure = (n = 0) => events(n).find((e) => e.type === "error");
/** The args with the fresh CLI session id (and the paths named after it) masked. */
const withoutSessionId = (argv: string[]) => {
  const id = argv[argv.indexOf("--session-id") + 1];
  const config = argv.indexOf("--mcp-config") + 1;
  return argv.map((arg, i) =>
    i === config ? "<config>" : arg.split(id).join("<id>"),
  );
};
const configAt = (i: number) => {
  const argv = argsAt(i);
  return argv[argv.indexOf("--mcp-config") + 1];
};
const fetchTool = {
  name: "fetch_content",
  description: "fetch a page",
  parameters: { type: "object", properties: {} },
};
const opts = (extra: any = {}) => ({
  sessionId: "lane",
  mcpConfig: {
    schemaPath: "/tmp/schema.json",
    version: "v1",
    handoffSocket: "/tmp/handoff.sock",
  },
  ...extra,
});
const ask = (extra?: any, tools: any[] = [fetchTool]) =>
  streamViaCli(
    model,
    { messages: [{ role: "user", content: "read the page" }], tools },
    opts(extra) as any,
  );
const settle = () => vi.advanceTimersByTimeAsync(10);

describe("MCP startup timeouts", () => {
  afterEach(() => {
    cleanupSystemPromptFile();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("gives the CLI's MCP client generous connect and startup limits when unset", () => {
    vi.stubEnv("MCP_CONNECT_TIMEOUT_MS", undefined);
    vi.stubEnv("MCP_TIMEOUT", undefined);
    spawnClaude("claude-haiku-4-5", undefined, {
      mcpConfigPath: "/pi/bridge.json",
    });
    const env = (spawn as any).mock.calls[0][2].env;
    expect(DEFAULT_MCP_CONNECT_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_MCP_TIMEOUT_MS).toBe(120_000);
    expect(env.MCP_CONNECT_TIMEOUT_MS).toBe("60000");
    expect(env.MCP_TIMEOUT).toBe("120000");
  });

  it("keeps the host's own limits", () => {
    vi.stubEnv("MCP_CONNECT_TIMEOUT_MS", "7000");
    vi.stubEnv("MCP_TIMEOUT", "9000");
    spawnClaude("claude-haiku-4-5", undefined, {});
    const env = (spawn as any).mock.calls[0][2].env;
    expect(env.MCP_CONNECT_TIMEOUT_MS).toBe("7000");
    expect(env.MCP_TIMEOUT).toBe("9000");
  });

  it("keeps a limit the host set to the empty string", () => {
    vi.stubEnv("MCP_CONNECT_TIMEOUT_MS", "");
    vi.stubEnv("MCP_TIMEOUT", "");
    spawnClaude("claude-haiku-4-5", undefined, {});
    const env = (spawn as any).mock.calls[0][2].env;
    expect(env.MCP_CONNECT_TIMEOUT_MS).toBe("");
    expect(env.MCP_TIMEOUT).toBe("");
  });
});

describe("custom-tools must be connected before Claude answers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetCliProcessesForTests();
    resetHandoffBrokerForTests();
    delete process.env.PI_CLAUDE_CLI_CONTEXT;
  });

  afterEach(() => {
    resetCliProcessesForTests();
    vi.useRealTimers();
  });

  it.each(["failed", "pending"])(
    "kills a process whose init reports custom-tools %s and respawns it once",
    async (status) => {
      ask();
      await vi.advanceTimersByTimeAsync(0);
      procAt(0).stdout.write(init(status));
      await settle();
      expect(procAt(0).kill).toHaveBeenCalledWith("SIGKILL");
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(withoutSessionId(argsAt(1))).toEqual(withoutSessionId(argsAt(0)));
      procAt(1).stdout.write(init("connected") + reply("fetched"));
      await settle();
      expect(failure()).toBeUndefined();
      expect(done().message.content[0].text).toBe("fetched");
    },
  );

  it("fails the turn when the retry cannot connect either", async () => {
    ask();
    await vi.advanceTimersByTimeAsync(0);
    procAt(0).stdout.write(init("failed"));
    await settle();
    procAt(1).stdout.write(init("pending"));
    await settle();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(procAt(1).kill).toHaveBeenCalledWith("SIGKILL");
    expect(done()).toBeUndefined();
    expect(failure().error.stopReason).toBe("error");
    expect(failure().error.errorMessage).toBe(
      "Claude Code could not connect pi's tools (MCP server custom-tools: pending). Try again.",
    );
  });

  it("does not touch a session that passes no MCP config", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "hi" }] }, {
      sessionId: "plain",
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    procAt(0).stdout.write(init("failed") + reply("hello"));
    await settle();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(done().message.content[0].text).toBe("hello");
  });
});

describe("custom-tools retry edges (default)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetCliProcessesForTests();
    resetHandoffBrokerForTests();
    delete process.env.PI_CLAUDE_CLI_CONTEXT;
  });

  afterEach(() => {
    resetCliProcessesForTests();
    vi.useRealTimers();
  });

  it("does not spawn the retry when pi aborted after the failed init", async () => {
    const controller = new AbortController();
    ask({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    // The abort lands after the retry was decided, before it spawns.
    const log = vi.spyOn(console, "error").mockImplementation((msg) => {
      if (String(msg).includes("spawning once more")) controller.abort();
    });
    procAt(0).stdout.write(init("failed"));
    await settle();
    log.mockRestore();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(failure().reason).toBe("aborted");
  });

  it("never checks MCP for a request with no tools", async () => {
    ask({}, []);
    await vi.advanceTimersByTimeAsync(0);
    procAt(0).stdout.write(init("failed") + reply("plain answer"));
    await settle();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(failure()).toBeUndefined();
    expect(done().message.content[0].text).toBe("plain answer");
  });
});

describe("custom-tools retry edges (legacy)", () => {
  let stateDir: string;
  const resumeMiss = line({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["No conversation found with session ID: cli-old"],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetCliProcessesForTests();
    resetHandoffBrokerForTests();
    process.env.PI_CLAUDE_CLI_CONTEXT = "legacy";
    stateDir = mkdtempSync(join(tmpdir(), "pcc-mcp-startup-"));
    process.env.PI_CLAUDE_CLI_STATE_DIR = stateDir;
    writeFileSync(
      join(stateDir, "session-map.json"),
      JSON.stringify({ lane: "cli-old" }),
    );
  });

  afterEach(() => {
    resetCliProcessesForTests();
    vi.useRealTimers();
    delete process.env.PI_CLAUDE_CLI_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("the killed process closing late leaves the replacement's MCP config", async () => {
    ask();
    await vi.advanceTimersByTimeAsync(0);
    expect(argsAt(0)).toContain("--resume");
    procAt(0).stdout.write(init("failed"));
    await settle();
    expect(spawn).toHaveBeenCalledTimes(2);
    const replacement = configAt(1);
    expect(existsSync(replacement)).toBe(true);
    procAt(0).emit("close", null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(existsSync(replacement)).toBe(true);
  });

  it("a resume miss uses the turn's one respawn: a failed init after it fails the turn", async () => {
    ask();
    await vi.advanceTimersByTimeAsync(0);
    procAt(0).stdout.write(init("connected") + resumeMiss);
    await settle();
    procAt(0).stdout.end();
    await settle();
    expect(spawn).toHaveBeenCalledTimes(2);
    procAt(1).stdout.write(init("failed"));
    await settle();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(failure().error.errorMessage).toMatch(/MCP server custom-tools/);
  });

  it("an MCP retry uses the turn's one respawn: a resume miss after it fails the turn", async () => {
    ask();
    await vi.advanceTimersByTimeAsync(0);
    procAt(0).stdout.write(init("failed"));
    await settle();
    expect(spawn).toHaveBeenCalledTimes(2);
    procAt(1).stdout.write(init("connected") + resumeMiss);
    await settle();
    procAt(1).stdout.end();
    await settle();
    expect(spawn).toHaveBeenCalledTimes(2);
    const ended = done() ?? failure();
    expect(JSON.stringify(ended)).toMatch(/No conversation found/);
  });

  it("two failed inits end the turn as a structured error", async () => {
    ask();
    await vi.advanceTimersByTimeAsync(0);
    procAt(0).stdout.write(init("failed"));
    await settle();
    procAt(1).stdout.write(init("failed"));
    await settle();
    expect(done()).toBeUndefined();
    expect(failure().reason).toBe("error");
    expect(failure().error.stopReason).toBe("error");
    expect(failure().error.errorMessage).toBe(
      "Claude Code could not connect pi's tools (MCP server custom-tools: failed). Try again.",
    );
  });
});
