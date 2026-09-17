import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Same harness as multi-cycle.test.ts: PassThrough stdout for readline.
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
import { resetCliProcessesForTests } from "../src/cli-process";
import { createEventBridge } from "../src/event-bridge";

const model = {
  id: "claude-opus-5",
  name: "Claude Opus 5",
  api: "pi-claude-cli",
  provider: "pi-claude-cli",
  reasoning: true,
  input: "text",
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 200000,
  maxTokens: 32000,
} as any;

/**
 * The record the CLI writes to its transcript for the two real compactions
 * captured on 2026-09-14 and 2026-09-16 (claude 2.1.268), camelCase as on
 * disk. The stream may spell the same object snake_case; both are exercised.
 */
const BOUNDARY_CAMEL = {
  type: "system",
  subtype: "compact_boundary",
  compactMetadata: {
    trigger: "auto",
    preTokens: 360561,
    postTokens: 37239,
    cumulativeDroppedTokens: 323322,
    durationMs: 166547,
  },
};

const BOUNDARY_SNAKE = {
  type: "system",
  subtype: "compact_boundary",
  compact_metadata: {
    trigger: "auto",
    pre_tokens: 368464,
    post_tokens: 12020,
    duration_ms: 136849,
  },
};

function createMockStream() {
  const events: unknown[] = [];
  return {
    push: vi.fn((event: unknown) => events.push(event)),
    end: vi.fn(),
    events,
  };
}

describe("handleCompactBoundary (bridge)", () => {
  function bridgeAfterSummarizationPass() {
    const stream = createMockStream();
    const bridge = createEventBridge(stream as any, model);
    // The summarization pass: an API call whose prompt is the whole
    // pre-compaction conversation. Its message_start is the last one the
    // bridge sees before the CLI carries on.
    bridge.handleEvent({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 205342,
          cache_creation_input_tokens: 155217,
        },
      },
    });
    expect(bridge.getOutput().usage.totalTokens).toBe(360561);
    return { bridge, stream };
  }

  it("resets the reported context to the compacted size", () => {
    const { bridge } = bridgeAfterSummarizationPass();
    bridge.handleCompactBoundary(BOUNDARY_CAMEL as any);
    expect(bridge.getOutput().usage.totalTokens).toBe(37239);
  });

  it("reads the snake_case spelling the stream uses for structured fields", () => {
    const { bridge } = bridgeAfterSummarizationPass();
    bridge.handleCompactBoundary(BOUNDARY_SNAKE as any);
    expect(bridge.getOutput().usage.totalTokens).toBe(12020);
  });

  it("keeps the summarization pass in the billed totals", () => {
    const { bridge } = bridgeAfterSummarizationPass();
    bridge.handleCompactBoundary(BOUNDARY_CAMEL as any);
    const usage = bridge.getOutput().usage;
    // The pass was spent; only the CONTEXT figure changes.
    expect(usage.cacheRead).toBe(205342);
    expect(usage.cacheWrite).toBe(155217);
  });

  it("does not re-latch the stale cycle on the next recompute", () => {
    const { bridge } = bridgeAfterSummarizationPass();
    bridge.handleCompactBoundary(BOUNDARY_CAMEL as any);
    // A message_delta on the same cycle recomputes usage; the banked cycle
    // must not come back as "the last cycle".
    bridge.handleEvent({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 12 },
    } as any);
    expect(bridge.getOutput().usage.totalTokens).toBe(37239);
  });

  it("appends a compact marker with only the figures the CLI reported", () => {
    const { bridge } = bridgeAfterSummarizationPass();
    bridge.handleCompactBoundary(BOUNDARY_CAMEL as any);
    const texts = bridge
      .getOutput()
      .content.filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    expect(texts).toEqual([
      '[Claude Code · compact {"trigger":"auto","preTokens":360561,"postTokens":37239,"durationMs":166547}]',
    ]);
  });

  it("leaves the context alone and still marks the cut when metadata is missing", () => {
    const { bridge } = bridgeAfterSummarizationPass();
    bridge.handleCompactBoundary({
      type: "system",
      subtype: "compact_boundary",
    } as any);
    expect(bridge.getOutput().usage.totalTokens).toBe(360561);
    const texts = bridge
      .getOutput()
      .content.filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    expect(texts).toEqual(["[Claude Code · compact {}]"]);
  });

  it("treats a non-numeric or negative figure as not reported", () => {
    const { bridge } = bridgeAfterSummarizationPass();
    bridge.handleCompactBoundary({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { trigger: "auto", postTokens: "37239", preTokens: -1 },
    } as any);
    expect(bridge.getOutput().usage.totalTokens).toBe(360561);
    const marker = bridge.getOutput().content[0] as any;
    expect(marker.text).toBe('[Claude Code · compact {"trigger":"auto"}]');
  });
});

describe("compact_boundary on the stream (provider routing)", () => {
  beforeEach(() => {
    resetCliProcessesForTests();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runEpisode(lines: unknown[]): Promise<any> {
    streamViaCli(model, { messages: [{ role: "user", content: "go" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;
    for (const line of lines) {
      proc.stdout.write(JSON.stringify(line) + "\n");
      await vi.advanceTimersByTimeAsync(0);
    }
    proc.stdout.end();
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const done = mockStream._events.find((e: any) => e.type === "done");
    expect(done).toBeDefined();
    return done.message;
  }

  it("routes the envelope to the bridge: marker in content, context reset", async () => {
    const message = await runEpisode([
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 2,
              cache_read_input_tokens: 205342,
              cache_creation_input_tokens: 155217,
            },
          },
        },
      },
      BOUNDARY_CAMEL,
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        usage: {
          input_tokens: 2,
          output_tokens: 0,
          cache_read_input_tokens: 205342,
          cache_creation_input_tokens: 155217,
        },
      },
    ]);
    const texts = message.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    expect(texts).toContainEqual(
      expect.stringMatching(/^\[Claude Code · compact /),
    );
    expect(message.usage.totalTokens).toBe(37239);
  });
});
