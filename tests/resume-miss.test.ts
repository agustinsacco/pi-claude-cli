import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("cross-spawn", () => ({
  default: vi.fn(() => {
    const proc = new EventEmitter();
    const stdin = { write: vi.fn(), end: vi.fn() };
    const stdout = new PassThrough();
    const stderr = new EventEmitter();
    (proc as any).stdin = stdin;
    (proc as any).stdout = stdout;
    (proc as any).stderr = stderr;
    (proc as any).killed = false;
    (proc as any).exitCode = null;
    (proc as any).kill = vi.fn(() => {
      (proc as any).killed = true;
    });
    (proc as any).pid = 99999;
    return proc;
  }),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("1.0.0")),
}));

const { MockAssistantMessageEventStream } = vi.hoisted(() => {
  const MockAssistantMessageEventStream: any = vi.fn(function (this: any) {
    const events: any[] = [];
    this.push = vi.fn((event: any) => events.push(event));
    this.end = vi.fn();
    this._events = events;
  });
  return { MockAssistantMessageEventStream };
});

vi.mock("@earendil-works/pi-ai", () => ({
  AssistantMessageEventStream: MockAssistantMessageEventStream,
  createAssistantMessageEventStream: vi.fn(
    () => new MockAssistantMessageEventStream(),
  ),
  calculateCost: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModels: vi.fn(() => []),
}));

import spawn from "cross-spawn";
import { streamViaCli } from "../src/provider";

const model = {
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  api: "pi-claude-cli",
  provider: "pi-claude-cli",
  reasoning: true,
  input: "text",
  cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 200000,
  maxTokens: 8192,
} as any;

/** A conversation whose history marks a prior pi-claude-cli turn (fork copy). */
const forkedContext = {
  messages: [
    { role: "user", content: "earlier" },
    { role: "assistant", provider: "pi-claude-cli", content: [] },
    { role: "user", content: "after the fork" },
  ],
};

const RESUME_MISS_LINE =
  JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    error: "No conversation found with session ID: 01a0225b-e713-7ba0",
  }) + "\n";

function textEpisode(text: string): string[] {
  return [
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { usage: { input_tokens: 5, output_tokens: 0 } },
      },
    }),
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    }),
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    }),
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    }),
    JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }),
    JSON.stringify({ type: "result", subtype: "success" }),
  ];
}

describe("resume-miss fallback (issue #2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries once with a full replay when --resume misses, and succeeds", async () => {
    streamViaCli(model, forkedContext, { sessionId: "forked-session-id" });
    await vi.advanceTimersByTimeAsync(0);

    // Attempt 1 resumed and the CLI has no such session.
    const proc1 = (spawn as any).mock.results[0].value;
    expect((spawn as any).mock.calls[0][1]).toContain("--resume");
    proc1.stdout.write(RESUME_MISS_LINE);
    await vi.advanceTimersByTimeAsync(0);
    proc1.stdout.end();
    await vi.advanceTimersByTimeAsync(0);

    // Attempt 2 replays full history under the current session id.
    expect((spawn as any).mock.calls).toHaveLength(2);
    const args2 = (spawn as any).mock.calls[1][1];
    expect(args2).not.toContain("--resume");
    expect(args2).toContain("--session-id");
    expect(args2).toContain("forked-session-id");

    const proc2 = (spawn as any).mock.results[1].value;
    for (const line of textEpisode("FORKED-TURN")) {
      proc2.stdout.write(line + "\n");
      await vi.advanceTimersByTimeAsync(0);
    }
    proc2.stdout.end();
    await vi.advanceTimersByTimeAsync(0);

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    expect(done).toBeDefined();
    expect(done.message.content[0].text).toBe("FORKED-TURN");
    // The recoverable miss never surfaced as an error to the user.
    const texts = done.message.content.map((c: any) => c.text ?? "");
    expect(texts.join(" ")).not.toMatch(/No conversation found/);
  });

  it("does not retry for unrelated errors on a resume attempt", async () => {
    streamViaCli(model, forkedContext, { sessionId: "forked-session-id" });
    await vi.advanceTimersByTimeAsync(0);

    const proc1 = (spawn as any).mock.results[0].value;
    proc1.stdout.write(
      JSON.stringify({ type: "result", subtype: "error", error: "boom" }) +
        "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    proc1.stdout.end();
    await vi.advanceTimersByTimeAsync(0);

    expect((spawn as any).mock.calls).toHaveLength(1);
    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    expect(done.message.content[0].text).toContain("boom");
  });

  it("surfaces resume-miss text as an error when no resume was attempted", async () => {
    // First turn: no prior provider message, so no --resume — the same error
    // string must not trigger a pointless retry loop.
    streamViaCli(
      model,
      { messages: [{ role: "user", content: "hi" }] },
      { sessionId: "fresh-session" },
    );
    await vi.advanceTimersByTimeAsync(0);

    const proc1 = (spawn as any).mock.results[0].value;
    expect((spawn as any).mock.calls[0][1]).not.toContain("--resume");
    proc1.stdout.write(RESUME_MISS_LINE);
    await vi.advanceTimersByTimeAsync(0);
    proc1.stdout.end();
    await vi.advanceTimersByTimeAsync(0);

    expect((spawn as any).mock.calls).toHaveLength(1);
    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    expect(done.message.content[0].text).toContain("No conversation found");
  });
});
