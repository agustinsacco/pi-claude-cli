/**
 * Every call that continues a session runs on the process that holds its
 * cached prefix. Each case here used to retire that process and re-import the
 * whole conversation as cache write; measured on one install over 30 days,
 * they were the misses left once idle expiry is set aside.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("cross-spawn", () => ({
  default: vi.fn(() => {
    const proc = new EventEmitter();
    (proc as any).stdin = { write: vi.fn(), end: vi.fn() };
    (proc as any).stdout = new PassThrough();
    (proc as any).stderr = new EventEmitter();
    (proc as any).killed = false;
    (proc as any).exitCode = null;
    (proc as any).kill = vi.fn(() => ((proc as any).killed = true));
    (proc as any).pid = 4242;
    return proc;
  }),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("2.1.312 (Claude Code)")),
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

// The real transcript helpers: system-message updates are pi's own format.
vi.mock("@earendil-works/pi-ai", async () => ({
  ...(await vi.importActual<any>("@earendil-works/pi-ai")),
  createAssistantMessageEventStream: vi.fn(() => new MockStream()),
  calculateCost: vi.fn(),
}));

import spawn from "cross-spawn";
import { streamViaCli } from "../src/provider";
import {
  resetCliProcessesForTests,
  parkedCliProcessCount,
} from "../src/cli-process";
import {
  dispatchHandoffCall,
  resetHandoffBrokerForTests,
} from "../src/handoff-broker";
import type { HandoffResult } from "../src/handoff-broker";

const model = {
  id: "claude-opus-5",
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
  ev({ type: "content_block_stop", index: 0 });
const endTurn =
  ev({ type: "message_delta", delta: { stop_reason: "end_turn" } }) +
  ev({ type: "message_stop" }) +
  line({ type: "result", subtype: "success", is_error: false });
const toolUse = (id: string, name: string) =>
  ev({ type: "message_start", message: { usage: { input_tokens: 1 } } }) +
  ev({
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      id,
      name: `mcp__custom-tools__${name}`,
      input: "",
    },
  }) +
  ev({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: "{}" },
  }) +
  ev({ type: "content_block_stop", index: 0 }) +
  ev({ type: "message_delta", delta: { stop_reason: "tool_use" } }) +
  ev({ type: "message_stop" });

const procAt = (i: number) => (spawn as any).mock.results[i].value;
const cliIdOf = (i: number) => {
  const a = (spawn as any).mock.calls[i][1] as string[];
  return a[a.indexOf("--session-id") + 1];
};
const userWrites = (proc: any): any[] =>
  (proc.stdin.write as any).mock.calls
    .map((c: any) => JSON.parse(String(c[0])))
    .filter((m: any) => m.type === "user")
    .map((m: any) => m.message.content);
const textOf = (content: any[]) => content.map((b) => b.text ?? "").join("\n");
const streamOf = (n: number) => MockStream.mock.instances[n]._events;
const doneOf = (n: number) => streamOf(n).find((e: any) => e.type === "done");
const assistant = (n: number) => ({
  role: "assistant",
  provider: "pi-claude-cli",
  api: "pi-claude-cli",
  content: doneOf(n).message.content,
});
const toolResult = (id: string, text: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "fetch_content",
  content: [{ type: "text", text }],
  isError: false,
});
const opts = (extra: any = {}) => ({
  sessionId: "lane",
  mcpConfig: {
    schemaPath: "/tmp/schema.json",
    version: "v1",
    handoffSocket: "/tmp/handoff.sock",
  },
  ...extra,
});
const settle = () => vi.advanceTimersByTimeAsync(10);

/** Run one handoff: the CLI calls `fetch_content` and waits on its tools/call. */
async function startHandoff(messages: any[]) {
  streamViaCli(model, { messages }, opts() as any);
  await vi.advanceTimersByTimeAsync(0);
  procAt(0).stdout.write(toolUse("t1", "fetch_content"));
  await settle();
  const answers: HandoffResult[] = [];
  dispatchHandoffCall(cliIdOf(0), {
    toolUseId: "t1",
    name: "fetch_content",
    arguments: {},
    respond: (r) => answers.push(r),
  });
  return { answers, history: [...messages, assistant(0)] };
}

describe("cache continuity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetCliProcessesForTests();
    resetHandoffBrokerForTests();
    delete process.env.PI_CLAUDE_CLI_CONTEXT;
    delete process.env.PI_CLAUDE_CLI_KEEPALIVE_MS;
  });

  afterEach(() => {
    resetCliProcessesForTests();
    vi.useRealTimers();
  });

  it.each([
    ["cacheRetention none", { cacheRetention: "none" }],
    ["foreign history", {}],
  ])(
    "a side call during a tool (%s) leaves the turn's process alone",
    async (_name, extra) => {
      const { answers, history } = await startHandoff([
        { role: "user", content: "read the page" },
      ]);
      // pi-web-access answers fetch_content with the session's model and id.
      streamViaCli(
        model,
        { messages: [{ role: "user", content: "answer from this page" }] },
        opts(extra) as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      procAt(1).stdout.write(reply("side answer") + endTurn);
      await settle();
      expect(doneOf(1).message.content[0].text).toBe("side answer");
      expect(procAt(1).stdin.end).toHaveBeenCalled(); // never parked
      expect(procAt(0).stdin.end).not.toHaveBeenCalled();
      expect(parkedCliProcessCount()).toBe(1);

      streamViaCli(
        model,
        { messages: [...history, toolResult("t1", "page text")] },
        opts() as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(answers).toEqual([
        { content: [{ type: "text", text: "page text" }] },
      ]);
    },
  );

  it("a message sent while a tool ran joins the same turn, after the results", async () => {
    const { answers, history } = await startHandoff([
      { role: "user", content: "read the page" },
    ]);
    const order: string[] = [];
    procAt(0).stdin.write.mockImplementation((s: string) => {
      order.push(JSON.parse(s).type);
    });
    answers.push = () => order.push("tool result");
    streamViaCli(
      model,
      {
        messages: [
          ...history,
          toolResult("t1", "page text"),
          { role: "user", content: "also check the date" },
        ],
      },
      opts() as any,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    // The CLI holds the message until the tool returns, then sends both.
    expect(order).toEqual(["user", "tool result"]);
    expect(textOf(userWrites(procAt(0)).at(-1))).toContain(
      "also check the date",
    );
    procAt(0).stdout.write(reply("done, and the date") + endTurn);
    await settle();
    expect(doneOf(1).reason).toBe("stop");
    expect(parkedCliProcessCount()).toBe(1);
  });

  describe("system-prompt updates", () => {
    const head = (sections: Record<string, string>) => ({
      role: "system",
      content: "base prompt",
      sections,
      timestamp: 1,
    });

    async function firstTurn() {
      const messages = [
        head({ mcp_servers: "<mcp_servers>linear</mcp_servers>" }),
        { role: "user", content: "first" },
      ];
      streamViaCli(model, { messages }, opts() as any);
      await vi.advanceTimersByTimeAsync(0);
      procAt(0).stdout.write(reply("one") + endTurn);
      await settle();
      return [...messages, assistant(0)];
    }

    it("ride with the next user message on the warm process", async () => {
      const history = await firstTurn();
      // pi records the change as a later system message.
      const update = {
        role: "system",
        content: "",
        sections: { mcp_servers: "<mcp_servers>linear, notion</mcp_servers>" },
        timestamp: 2,
      };
      const second = [...history, update, { role: "user", content: "second" }];
      streamViaCli(model, { messages: second }, opts() as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      const sent = userWrites(procAt(0)).at(-1);
      expect(sent[0].text).toBe(
        '<system-reminder>\nUpdated system prompt section "mcp_servers":\n\n' +
          "<mcp_servers>linear, notion</mcp_servers>\n</system-reminder>",
      );
      expect(textOf(sent)).toContain("second");

      // Told once: the next turn carries no update.
      procAt(0).stdout.write(reply("two") + endTurn);
      await settle();
      streamViaCli(
        model,
        {
          messages: [
            ...second,
            assistant(1),
            { role: "user", content: "third" },
          ],
        },
        opts() as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(textOf(userWrites(procAt(0)).at(-1))).not.toContain(
        "system-reminder",
      );
    });

    it("a request-local patch of the first system message is an update too", async () => {
      const history = await firstTurn();
      // Swarm and the global AGENTS.md swap edit the leading message per request.
      history[0] = head({
        mcp_servers: "<mcp_servers>linear</mcp_servers>",
        phosphor_swarm: "<phosphor_swarm>on</phosphor_swarm>",
      });
      streamViaCli(
        model,
        { messages: [...history, { role: "user", content: "second" }] },
        opts() as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(userWrites(procAt(0)).at(-1)[0].text).toContain(
        'Updated system prompt section "phosphor_swarm"',
      );
    });

    it("a rewritten base prompt still needs a fresh process", async () => {
      const history = await firstTurn();
      history[0] = { ...history[0], content: "another prompt" };
      streamViaCli(
        model,
        { messages: [...history, { role: "user", content: "second" }] },
        opts() as any,
      );
      await vi.advanceTimersByTimeAsync(600);
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it("wait out a tool loop rather than end it", async () => {
      const { answers, history } = await startHandoff([
        head({ mcp_servers: "<mcp_servers>linear</mcp_servers>" }),
        { role: "user", content: "read the page" },
      ]);
      history[0] = head({ mcp_servers: "<mcp_servers>notion</mcp_servers>" });
      streamViaCli(
        model,
        { messages: [...history, toolResult("t1", "page text")] },
        opts() as any,
      );
      await vi.advanceTimersByTimeAsync(3_000); // past any retire grace
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(answers).toEqual([
        { content: [{ type: "text", text: "page text" }] },
      ]);
      expect(userWrites(procAt(0))).toHaveLength(1);
    });
  });

  describe("abort", () => {
    async function abortedTurn() {
      const controller = new AbortController();
      const messages = [{ role: "user", content: "first" }];
      streamViaCli(
        model,
        { messages },
        opts({ signal: controller.signal }) as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      procAt(0).stdout.write(reply("partial"));
      await settle();
      controller.abort();
      return messages;
    }

    it("answers pi at once and parks the interrupted process for the next turn", async () => {
      const messages = await abortedTurn();
      expect(streamOf(0).find((e: any) => e.type === "error").reason).toBe(
        "aborted",
      );
      const sent = (procAt(0).stdin.write as any).mock.calls.map((c: any) =>
        String(c[0]),
      );
      expect(sent.join("")).toContain('"interrupt"');
      procAt(0).stdout.write(
        line({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
        }),
      );
      await settle();
      expect(parkedCliProcessCount()).toBe(1);

      streamViaCli(
        model,
        {
          messages: [
            ...messages,
            {
              role: "assistant",
              provider: "pi-claude-cli",
              stopReason: "aborted",
              content: [{ type: "text", text: "partial" }],
            },
            { role: "user", content: "second" },
          ],
        },
        opts() as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      const turn = textOf(userWrites(procAt(0)).at(-1));
      expect(turn).toContain("second");
      expect(turn).not.toContain("first");
    });

    it("retires a process that never settles the interrupt", async () => {
      await abortedTurn();
      await vi.advanceTimersByTimeAsync(5_000 + 2_600);
      expect(parkedCliProcessCount()).toBe(0);
      expect(procAt(0).stdin.end).toHaveBeenCalled();
    });

    it("the next prompt waits for the interrupt to settle, then reuses the process", async () => {
      const messages = await abortedTurn();
      // pi is idle at once, so the next prompt can beat the CLI's result.
      streamViaCli(
        model,
        { messages: [...messages, { role: "user", content: "second" }] },
        opts() as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(userWrites(procAt(0))).toHaveLength(1);
      procAt(0).stdout.write(
        line({ type: "result", subtype: "error_during_execution" }),
      );
      await settle();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(textOf(userWrites(procAt(0)).at(-1))).toContain("second");
    });
  });

  describe("cache lifetime", () => {
    const ttlOf = (i: number) =>
      (spawn as any).mock.calls[i][2].env.CLAUDE_CODE_PROMPT_CACHE_TTL;
    async function turn(extra: any) {
      streamViaCli(
        model,
        { messages: [{ role: "user", content: "hi" }] },
        opts(extra) as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      procAt(0).stdout.write(reply("hello") + endTurn);
      await settle();
    }
    beforeEach(() => {
      delete process.env.PI_CACHE_RETENTION;
      delete process.env.CLAUDE_CODE_PROMPT_CACHE_TTL;
      process.env.PI_CLAUDE_CLI_KEEPALIVE_MS = "3600000";
    });
    afterEach(() => delete process.env.PI_CACHE_RETENTION);

    it.each([
      // pi-subagents pins this on an in-process child's requests.
      ["a sub-agent's", { env: { PI_CACHE_RETENTION: "short" } }, "", "5m"],
      ["a spawned sub-agent's", {}, "short", "5m"],
      ["an explicit long", { cacheRetention: "long" }, "", "1h"],
      ["no", {}, "", undefined],
    ])(
      "asks the CLI for the cache lifetime pi asked for (%s retention)",
      async (_name, extra, processEnv, ttl) => {
        if (processEnv) process.env.PI_CACHE_RETENTION = processEnv;
        await turn(extra);
        expect(ttlOf(0)).toBe(ttl);
      },
    );

    it("parks a short-retention process only while its cache lives", async () => {
      await turn({ env: { PI_CACHE_RETENTION: "short" } });
      expect(parkedCliProcessCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(parkedCliProcessCount()).toBe(0);
    });

    it("keeps the host's keepalive when no retention was asked for", async () => {
      await turn({});
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(parkedCliProcessCount()).toBe(1);
    });
  });
});
