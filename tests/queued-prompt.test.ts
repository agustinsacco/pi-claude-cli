/**
 * The CLI can answer a prompt of its OWN before ours.
 *
 * On `--resume` it drains its queue first, and a session whose previous turn
 * launched a background task finds a `<task-notification>` sitting there. The
 * CLI decides that notification needs no reply and emits `result` in under a
 * second, having never called the model — with our prompt still queued.
 *
 * Ending the episode there handed pi an empty assistant message ("the first
 * message does nothing"), and left the CLI transcript ending on an unanswered
 * user entry, so the next resume spliced filler in and re-billed the whole
 * context as cache write. Captured 2026-09-01 on claude 2.1.258.
 */
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

const sse = (event: any) => JSON.stringify({ type: "stream_event", event });

/** The shape the CLI emits for a queued prompt it answers without the model. */
const EMPTY_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
});

/** A real answer: one text block and the tokens it cost. */
const ANSWER_LINES = [
  sse({ type: "message_start", message: { usage: { input_tokens: 12 } } }),
  sse({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  sse({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Not yet — validate is still running." },
  }),
  sse({ type: "content_block_stop", index: 0 }),
  sse({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 9 },
  }),
  sse({ type: "message_stop" }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Not yet — validate is still running.",
    usage: {
      input_tokens: 12,
      output_tokens: 9,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 50,
    },
  }),
];

async function feed(proc: any, lines: string[]): Promise<void> {
  for (const line of lines) {
    proc.stdout.write(line + "\n");
    await vi.advanceTimersByTimeAsync(0);
  }
}

function doneEvent(): any {
  const stream = MockAssistantMessageEventStream.mock.instances[0];
  return stream._events.find((e: any) => e.type === "done");
}

describe("a result the CLI spent on its own queued prompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps reading, so our prompt still gets answered", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "done?" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;

    // Cycle 1: the orphan task-notification, answered with nothing.
    await feed(proc, [EMPTY_RESULT]);
    expect(doneEvent()).toBeUndefined();

    // Cycle 2: our prompt finally runs.
    await feed(proc, ANSWER_LINES);
    const done = doneEvent();
    expect(done).toBeDefined();
    expect(done.message.content).toHaveLength(1);
    expect(done.message.content[0].text).toContain("Not yet");
    expect(done.message.usage.output).toBe(9);
  });

  it("still ends the turn when the CLI exits without ever answering", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "done?" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;

    await feed(proc, [EMPTY_RESULT]);
    proc.stdout.end();
    proc.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(0);

    expect(doneEvent()).toBeDefined();
  });

  it("stops waiting after MAX_EMPTY_CONTINUATIONS empty results", async () => {
    streamViaCli(model, { messages: [{ role: "user", content: "done?" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;

    // Four are tolerated; the fifth ends the episode rather than spinning.
    await feed(proc, [EMPTY_RESULT, EMPTY_RESULT, EMPTY_RESULT, EMPTY_RESULT]);
    expect(doneEvent()).toBeUndefined();
    await feed(proc, [EMPTY_RESULT]);
    expect(doneEvent()).toBeDefined();
  });

  it("ends the episode on a result that spent tokens but said nothing", async () => {
    // A model that legitimately answers with silence still bills for the
    // call — that is a finished turn, not a queue-drain cycle.
    streamViaCli(model, { messages: [{ role: "user", content: "hi" }] });
    await vi.advanceTimersByTimeAsync(0);
    const proc = (spawn as any).mock.results[0].value;

    await feed(proc, [
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        usage: {
          input_tokens: 7,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    ]);
    expect(doneEvent()).toBeDefined();
  });
});
