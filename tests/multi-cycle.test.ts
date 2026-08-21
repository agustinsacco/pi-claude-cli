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

  it("reports the episode's cumulative usage, not the last cycle's", async () => {
    const { message } = await runEpisode();
    // Authoritative totals from the result envelope (equal to per-cycle sums).
    expect(message.usage.input).toBe(28);
    expect(message.usage.output).toBe(429);
    expect(message.usage.cacheRead).toBe(64055);
    expect(message.usage.cacheWrite).toBe(17662);
    expect(message.usage.totalTokens).toBe(28 + 429 + 64055 + 17662);
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
  });
});
