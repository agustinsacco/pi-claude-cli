import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Same harness as provider.test.ts: PassThrough stdout for readline.
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

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * A real captured `claude -p --output-format stream-json
 * --include-partial-messages` episode (claude 2.1.237, 2026-08-21): three
 * cycles — thinking + ToolSearch, thinking + WebSearch, thinking + final
 * text — with tool_result user envelopes between cycles and a result
 * envelope carrying the cumulative usage (input 28, output 429,
 * cache_read 64055, cache_creation 17662).
 */
const EPISODE = readFileSync(
  join(__dirname, "fixtures", "multi-cycle-episode.jsonl"),
  "utf8",
);

describe("multi-cycle episodes (issue #3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runEpisode(): Promise<any> {
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;
    for (const line of EPISODE.split("\n")) {
      if (line.trim()) proc.stdout.write(line + "\n");
      await vi.advanceTimersByTimeAsync(0);
    }
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    expect(done).toBeDefined();
    return { message: done.message, events: mockStream._events };
  }

  it("keeps every cycle's content in order and never loses the final answer", async () => {
    const { message } = await runEpisode();
    const kinds = message.content.map((c: any) => c.type);

    // Three thinking blocks (one per cycle), no cross-cycle folding.
    expect(kinds.filter((k: string) => k === "thinking")).toHaveLength(3);

    // The final text block is the episode's actual answer, positioned last.
    const texts = message.content.filter((c: any) => c.type === "text");
    const finalText = texts[texts.length - 1].text;
    expect(finalText).toContain("grant access so I can search");
    expect(message.content[message.content.length - 1].type).toBe("text");

    // The safety net must not duplicate text the SSE stream already carried.
    const occurrences = texts.filter((t: any) =>
      t.text.includes("grant access so I can search"),
    );
    expect(occurrences).toHaveLength(1);
  });

  it("surfaces CLI-side tools as marker blocks instead of dropping them", async () => {
    const { message } = await runEpisode();
    const texts = message.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);

    expect(
      texts.some((t: string) => t.startsWith("[Claude Code · ToolSearch")),
    ).toBe(true);
    expect(
      texts.some((t: string) => t.startsWith("[Claude Code · WebSearch")),
    ).toBe(true);
    // No pi tool calls leak out of a CLI-side-only episode.
    expect(message.content.some((c: any) => c.type === "toolCall")).toBe(false);
    expect(message.stopReason).toBe("stop");
  });

  it("surfaces natively-executed built-in tools as markers, never as pi toolCalls", async () => {
    // Observer mode: the CLI runs Read/Bash/etc. itself mid-episode. pi sees
    // activity markers; a built-in must never become a pi toolCall and must
    // never end the episode early.
    const sse = (event: any) => JSON.stringify({ type: "stream_event", event });
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;

    const lines = [
      // Cycle 1: the model calls Read; the CLI executes it natively.
      sse({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
      sse({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "Read" },
      }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 2 },
      }),
      sse({ type: "message_stop" }),
      // Envelope for the completed Read block → marker.
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Read",
              input: { file_path: "/a.txt" },
            },
          ],
        },
      }),
      // CLI feeds the tool result back internally.
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "hi" }],
        },
      }),
      // Cycle 2: the final answer.
      sse({ type: "message_start", message: { usage: { input_tokens: 9 } } }),
      sse({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      sse({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "the file says hi" },
      }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 4 },
      }),
      sse({ type: "message_stop" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];
    for (const line of lines) {
      proc.stdout.write(line + "\n");
      await vi.advanceTimersByTimeAsync(0);
    }
    proc.stdout.end();
    await vi.advanceTimersByTimeAsync(600);

    // The turn ran to completion: no interrupt asked for, no kill before the
    // 500ms post-result reap.
    const written = (proc.stdin.write as any).mock.calls
      .map((c: any) => String(c[0]))
      .join("");
    expect(written).not.toContain('"interrupt"');

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    expect(done).toBeDefined();
    expect(done.message.stopReason).toBe("stop");
    expect(done.message.content.some((c: any) => c.type === "toolCall")).toBe(
      false,
    );
    const texts = done.message.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    expect(texts.some((t: string) => t.startsWith("[Claude Code · Read"))).toBe(
      true,
    );
    expect(texts.some((t: string) => t.includes("the file says hi"))).toBe(
      true,
    );
  });

  it("bills every model the episode used, not just the main agent", async () => {
    const { message } = await runEpisode();

    // `result.usage` covers the MAIN AGENT only: 28 / 429 / 64055 / 17662.
    // `result.modelUsage` adds the work that never reaches the parent stream
    // — here the haiku auto-titler's 906 input + 12 output. In the wild that
    // slice is sub-agents, and it dwarfed the main agent (28.6M cache-read
    // tokens against 1.96M, reported as $2.34 of a real ~$24).
    expect(message.usage.input).toBe(28 + 906);
    expect(message.usage.output).toBe(429 + 12);
    expect(message.usage.cacheRead).toBe(64055);
    expect(message.usage.cacheWrite).toBe(17662);
  });

  it("reports context as the last cycle's prompt, not the summed cycles", async () => {
    const { message } = await runEpisode();

    // Per-cycle prompt sizes in the capture: the prefix is re-read every
    // cycle, so it appears in all three.
    //   cycle 0: 10 + 17825 + 7561 = 25396
    //   cycle 1: 10 + 18134 + 9962 = 28106
    //   cycle 2:  8 + 28096 +  139 = 28243
    // pi treats totalTokens as context, so only the last one is right.
    expect(message.usage.totalTokens).toBe(8 + 28096 + 139);

    // Guard the regression explicitly: the old value was the sum of all four
    // cumulative components, 2.9x the real context on this 3-cycle episode.
    expect(message.usage.totalTokens).not.toBe(28 + 429 + 64055 + 17662);
    expect(message.usage.totalTokens).toBeLessThan(message.usage.cacheRead);
  });

  it("sums per-cycle usage when the episode ends without a result envelope", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;

    // Two SSE-only cycles (break-early style: killed before `result`).
    const lines = EPISODE.split("\n").filter((l) => {
      if (!l.trim()) return false;
      const rec = JSON.parse(l);
      return rec.type === "stream_event";
    });
    // First two cycles = everything up to the second message_stop.
    let stops = 0;
    for (const line of lines) {
      proc.stdout.write(line + "\n");
      await vi.advanceTimersByTimeAsync(0);
      if (JSON.parse(line).event.type === "message_stop" && ++stops === 2)
        break;
    }
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    // Cycle finals from the capture: (10+155) + (10+95) outputs/inputs.
    expect(done.message.usage.input).toBe(20);
    expect(done.message.usage.output).toBe(250);
    expect(done.message.usage.cacheRead).toBe(17825 + 18134);
    expect(done.message.usage.cacheWrite).toBe(7561 + 9962);
    // Context still tracks the newest cycle even with no result envelope.
    expect(done.message.usage.totalTokens).toBe(10 + 18134 + 9962);
  });
});

describe("rate limit forwarding (account state, not turn content)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it("hands rate_limit_event to the host and keeps it out of the message", async () => {
    const seen: Array<Record<string, unknown>> = [];
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] }, {
      onRateLimit: (info: Record<string, unknown>) => seen.push(info),
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;

    // Captured verbatim from claude 2.1.237.
    proc.stdout.write(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          resetsAt: 1787331600,
          rateLimitType: "five_hour",
          overageStatus: "rejected",
          isUsingOverage: false,
        },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(
      JSON.stringify({ type: "result", subtype: "success", result: "hi" }) +
        "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      rateLimitType: "five_hour",
      resetsAt: 1787331600,
    });

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    const text = (done.message.content as any[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).not.toContain("rate_limit");
    expect(text).not.toContain("five_hour");
  });

  it("survives a host callback that throws", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] }, {
      onRateLimit: () => {
        throw new Error("host blew up");
      },
    } as any);
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;
    proc.stdout.write(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "still here",
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    expect(
      mockStream._events.find((e: any) => e.type === "done"),
    ).toBeDefined();
  });
});
