import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Mock cross-spawn with PassThrough streams for readline compatibility
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

// Mock child_process.execSync for validateCliPresence/validateCliAuth
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("1.0.0")),
}));

// Mock @earendil-works/pi-ai
const mockModels = [
  {
    id: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5",
    api: "anthropic",
    provider: "anthropic",
    reasoning: false,
    input: "text",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: "claude-opus-4-6-20260301",
    name: "Claude Opus 4.6",
    api: "anthropic",
    provider: "anthropic",
    reasoning: true,
    input: "text",
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 16384,
  },
];

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
  getBuiltinModels: vi.fn(() => mockModels),
}));

import spawn from "cross-spawn";
import { streamViaCli } from "../src/provider";

describe("provider registration (default export)", () => {
  it("registers provider with ID pi-claude-cli", async () => {
    const registerProvider = vi.fn();
    const mockPi = { registerProvider, on: vi.fn() } as any;

    // Dynamic import to get the default export
    const mod = await import("../index");
    mod.default(mockPi);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider.mock.calls[0][0]).toBe("pi-claude-cli");
  });

  it("registers provider with correct config shape", async () => {
    const registerProvider = vi.fn();
    const mockPi = { registerProvider, on: vi.fn() } as any;

    const mod = await import("../index");
    mod.default(mockPi);

    const config = registerProvider.mock.calls[0][1];
    expect(config.baseUrl).toBe("pi-claude-cli");
    expect(config.apiKey).toBe("unused");
    expect(config.api).toBe("pi-claude-cli");
    expect(config.models).toBeDefined();
    expect(Array.isArray(config.models)).toBe(true);
    expect(config.streamSimple).toBeDefined();
    expect(typeof config.streamSimple).toBe("function");
  });

  it("derives models from getModels('anthropic') with correct fields", async () => {
    const registerProvider = vi.fn();
    const mockPi = { registerProvider, on: vi.fn() } as any;

    const mod = await import("../index");
    mod.default(mockPi);

    const config = registerProvider.mock.calls[0][1];
    expect(config.models.length).toBeGreaterThan(0);

    const firstModel = config.models[0];
    expect(firstModel.id).toBe("claude-sonnet-4-5-20250929");
    expect(firstModel.name).toBe("Claude Sonnet 4.5");
    expect(firstModel.contextWindow).toBe(200000);
    expect(firstModel.maxTokens).toBe(8192);
    expect(firstModel.cost).toBeDefined();
  });
});

describe("streamViaCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an AssistantMessageEventStream", () => {
    const model = mockModels[0] as any;
    const context = {
      messages: [{ role: "user", content: "Hello" }],
      systemPrompt: "Be helpful",
    };

    const result = streamViaCli(model, context);
    expect(result).toBeDefined();
    expect(result.push).toBeDefined();
    expect(result.end).toBeDefined();
  });

  it("spawns subprocess and writes user message to stdin", async () => {
    const model = mockModels[0] as any;
    const context = {
      messages: [{ role: "user", content: "Hello" }],
    };

    streamViaCli(model, context);

    // Allow async IIFE to start
    await vi.advanceTimersByTimeAsync(0);

    // Verify spawn was called
    expect(spawn).toHaveBeenCalled();

    // Verify user message was written to stdin
    const proc = (spawn as any).mock.results[0].value;
    expect(proc.stdin.write).toHaveBeenCalledTimes(1);

    const written = proc.stdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
  });

  it("handles full text streaming sequence via NDJSON", async () => {
    const model = mockModels[0] as any;
    const context = {
      messages: [{ role: "user", content: "Hello" }],
    };

    streamViaCli(model, context);
    await vi.advanceTimersByTimeAsync(0);

    // Get the mock process
    const proc = (spawn as any).mock.results[0].value;

    // Simulate NDJSON output on stdout
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "test" }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { usage: { input_tokens: 10, output_tokens: 0 } },
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
          delta: { type: "text_delta", text: "Hello" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " world" },
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
          usage: { output_tokens: 5 },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: { type: "message_stop" },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Hello world",
      }),
    ];

    // Write each line to stdout PassThrough stream (readline reads from it)
    for (const line of lines) {
      proc.stdout.write(line + "\n");
    }
    // End the stream so readline finishes
    proc.stdout.end();

    // Allow async processing
    await vi.advanceTimersByTimeAsync(100);

    // The stream should have received events from the event bridge
    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const events = mockStream._events;

    // Verify we got the expected event types
    const eventTypes = events.map((e: any) => e.type);
    expect(eventTypes).toContain("text_start");
    expect(eventTypes).toContain("text_delta");
    expect(eventTypes).toContain("text_end");
    expect(eventTypes).toContain("done");
  });

  it("handles result error by pushing error event", async () => {
    const model = mockModels[0] as any;
    const context = {
      messages: [{ role: "user", content: "Hello" }],
    };

    streamViaCli(model, context);
    await vi.advanceTimersByTimeAsync(0);

    const proc = (spawn as any).mock.results[0].value;

    // Write error result to stdout
    const errorLine = JSON.stringify({
      type: "result",
      subtype: "error",
      error: "Rate limit exceeded",
    });
    proc.stdout.write(errorLine + "\n");
    proc.stdout.end();
    await vi.advanceTimersByTimeAsync(100);

    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const doneEvent = mockStream._events.find(
      (e: any) => e.type === "done" && e.message,
    );
    expect(doneEvent).toBeDefined();
    expect(doneEvent.message.content).toBeDefined();
    expect(mockStream.end).toHaveBeenCalled();
  });

  it("calls cleanupProcess after receiving result", async () => {
    const model = mockModels[0] as any;
    const context = {
      messages: [{ role: "user", content: "Hello" }],
    };

    streamViaCli(model, context);
    await vi.advanceTimersByTimeAsync(0);

    const proc = (spawn as any).mock.results[0].value;

    // Write result to stdout
    proc.stdout.write(
      JSON.stringify({ type: "result", subtype: "success", result: "ok" }) +
        "\n",
    );
    proc.stdout.end();
    await vi.advanceTimersByTimeAsync(100);

    // Advance timer past cleanup grace period (500ms after Phase 5 hardening)
    vi.advanceTimersByTime(500);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("aborts with a clean interrupt, then a SIGKILL backstop", async () => {
    const model = mockModels[0] as any;
    const context = {
      messages: [{ role: "user", content: "Hello" }],
    };
    const controller = new AbortController();

    streamViaCli(model, context, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);

    const proc = (spawn as any).mock.results[0].value;

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    // First move is the CLI's own interrupt, so the session file stays
    // truthful and resumable — never an immediate kill.
    const written = (proc.stdin.write as any).mock.calls
      .map((c: any) => String(c[0]))
      .join("");
    expect(written).toContain('"interrupt"');
    expect(proc.kill).not.toHaveBeenCalled();

    // If the CLI never winds down, the 2s backstop force-kills.
    await vi.advanceTimersByTimeAsync(2100);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

    proc.stdout.end();
    await vi.advanceTimersByTimeAsync(100);
  });

  it("routes control_request through handleControlRequest and writes response to stdin", async () => {
    const model = mockModels[0] as any;
    const context = {
      messages: [{ role: "user", content: "Hello" }],
    };

    streamViaCli(model, context);
    await vi.advanceTimersByTimeAsync(0);

    const proc = (spawn as any).mock.results[0].value;

    // Clear initial stdin.write (user message)
    proc.stdin.write.mockClear();

    // Simulate a control_request NDJSON line arriving on stdout
    const controlRequest = JSON.stringify({
      type: "control_request",
      request_id: "req_123",
      request: {
        subtype: "can_use_tool",
        tool_name: "Read",
        input: { file_path: "/foo.ts" },
      },
    });

    // Then follow with stream events and result so stream completes
    const lines = [
      controlRequest,
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { usage: { input_tokens: 10, output_tokens: 0 } },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: { type: "message_stop" },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
      }),
    ];

    for (const line of lines) {
      proc.stdout.write(line + "\n");
    }
    proc.stdout.end();
    await vi.advanceTimersByTimeAsync(100);

    // Verify control_response was written to stdin
    expect(proc.stdin.write).toHaveBeenCalled();
    const stdinCalls = proc.stdin.write.mock.calls;
    const controlResponse = stdinCalls.find((call: any[]) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.type === "control_response";
      } catch {
        return false;
      }
    });
    expect(controlResponse).toBeDefined();
    const parsed = JSON.parse(controlResponse[0]);
    expect(parsed.response.request_id).toBe("req_123");
    expect(parsed.response.response.behavior).toBe("allow");
  });

  describe("thinking effort wiring", () => {
    it("passes effort to spawnClaude when options.reasoning is provided on non-Opus model", async () => {
      const model = mockModels[0] as any; // sonnet (non-Opus)
      const context = {
        messages: [{ role: "user", content: "Think about this" }],
      };

      streamViaCli(model, context, { reasoning: "high" } as any);
      await vi.advanceTimersByTimeAsync(0);

      // Verify spawn was called with effort arg
      const args = (spawn as any).mock.calls[0][1] as string[];
      expect(args).toContain("--effort");
      const idx = args.indexOf("--effort");
      expect(args[idx + 1]).toBe("high");
    });

    // #22: the opus shift sent `max` for `high`, and Claude Code skills size
    // their sub-agent fan-out from this flag.
    it("passes high effort to spawnClaude for high reasoning on Opus, not max", async () => {
      const model = mockModels[1] as any; // opus
      const context = {
        messages: [{ role: "user", content: "Think about this" }],
      };

      streamViaCli(model, context, { reasoning: "high" } as any);
      await vi.advanceTimersByTimeAsync(0);

      const args = (spawn as any).mock.calls[0][1] as string[];
      expect(args).toContain("--effort");
      const idx = args.indexOf("--effort");
      expect(args[idx + 1]).toBe("high");
    });

    it("does not pass effort when reasoning is undefined", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const args = (spawn as any).mock.calls[0][1] as string[];
      expect(args).not.toContain("--effort");
    });

    it("passes medium effort for medium reasoning on non-Opus", async () => {
      const model = mockModels[0] as any; // sonnet
      const context = {
        messages: [{ role: "user", content: "Think" }],
      };

      streamViaCli(model, context, { reasoning: "medium" } as any);
      await vi.advanceTimersByTimeAsync(0);

      const args = (spawn as any).mock.calls[0][1] as string[];
      const idx = args.indexOf("--effort");
      expect(args[idx + 1]).toBe("medium");
    });

    it("passes medium effort for medium reasoning on Opus too (no up-shift)", async () => {
      const model = mockModels[1] as any; // opus
      const context = {
        messages: [{ role: "user", content: "Think" }],
      };

      streamViaCli(model, context, { reasoning: "medium" } as any);
      await vi.advanceTimersByTimeAsync(0);

      const args = (spawn as any).mock.calls[0][1] as string[];
      const idx = args.indexOf("--effort");
      expect(args[idx + 1]).toBe("medium");
    });
  });

  it("stream events continue flowing after control_request handling", async () => {
    const model = mockModels[0] as any;
    const context = {
      messages: [{ role: "user", content: "Hello" }],
    };

    streamViaCli(model, context);
    await vi.advanceTimersByTimeAsync(0);

    const proc = (spawn as any).mock.results[0].value;

    // control_request followed by normal stream events
    const lines = [
      JSON.stringify({
        type: "control_request",
        request_id: "req_456",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "ls" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { usage: { input_tokens: 10, output_tokens: 0 } },
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
          delta: { type: "text_delta", text: "After control" },
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
          usage: { output_tokens: 3 },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: { type: "message_stop" },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
      }),
    ];

    for (const line of lines) {
      proc.stdout.write(line + "\n");
    }
    proc.stdout.end();
    await vi.advanceTimersByTimeAsync(100);

    // Verify the stream still received text events after the control_request
    const mockStream = MockAssistantMessageEventStream.mock.instances[0];
    const events = mockStream._events;
    const eventTypes = events.map((e: any) => e.type);
    expect(eventTypes).toContain("text_start");
    expect(eventTypes).toContain("text_delta");
    expect(eventTypes).toContain("done");
  });

  describe("mcpConfigPath passthrough", () => {
    it("passes mcpConfigPath to spawnClaude options", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };

      streamViaCli(model, context, {
        mcpConfigPath: "/tmp/mcp-config.json",
      } as any);
      await vi.advanceTimersByTimeAsync(0);

      const args = (spawn as any).mock.calls[0][1] as string[];
      expect(args).toContain("--mcp-config");
      const idx = args.indexOf("--mcp-config");
      expect(args[idx + 1]).toBe("/tmp/mcp-config.json");

      // End stdout to prevent hanging
      const proc = (spawn as any).mock.results[0].value;
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);
    });
  });

  describe("break-early logic", () => {
    it("does NOT intervene when a built-in tool_use is seen — the CLI executes it natively", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Read a file" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      // Simulate tool_use stream: message_start, content_block_start (tool_use Read),
      // content_block_delta (input_json_delta), content_block_stop, message_delta, message_stop
      const lines = [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool_1",
              name: "Read",
              input: "",
            },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: '{"file_path":"/foo.ts"}',
            },
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
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 5 },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
        }),
      ];

      for (const line of lines) {
        proc.stdout.write(line + "\n");
      }
      // End stdout to let readline close
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      // Observer mode: no kill, no interrupt — the CLI runs the tool itself.
      expect(proc.kill).not.toHaveBeenCalled();
      const written = (proc.stdin.write as any).mock.calls
        .map((c: any) => String(c[0]))
        .join("");
      expect(written).not.toContain('"interrupt"');

      // And no pi toolCall events: built-ins are not pi's to execute.
      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const eventTypes = mockStream._events.map((e: any) => e.type);
      expect(eventTypes).not.toContain("toolcall_start");
      // done arrives after stdout ends with no result (stream closed), via
      // the post-close push.
      expect(eventTypes).toContain("done");
    });

    it("interrupts cleanly (never SIGKILL) at message_stop when a handoff tool is seen", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Search for something" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      const lines = [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool_2",
              name: "mcp__custom-tools__search",
              input: "",
            },
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
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 5 },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
        }),
      ];

      for (const line of lines) {
        proc.stdout.write(line + "\n");
      }
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      // A clean interrupt was asked for on stdin…
      const written = (proc.stdin.write as any).mock.calls
        .map((c: any) => String(c[0]))
        .join("");
      expect(written).toContain('"control_request"');
      expect(written).toContain('"interrupt"');
      // …and the process was NOT SIGKILLed mid-turn (a kill truncates the CLI
      // transcript and poisons every later resume with synthetic filler).
      expect(proc.kill).not.toHaveBeenCalled();

      // The interrupted turn's result envelope is expected, not an error.
      proc.stdout.write(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          usage: { input_tokens: 10, output_tokens: 5 },
        }) + "\n",
      );
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(600);

      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const done = mockStream._events.find((e: any) => e.type === "done");
      expect(done).toBeDefined();
      expect(done.reason).toBe("toolUse");
      const toolCalls = done.message.content.filter(
        (c: any) => c.type === "toolCall",
      );
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("search");
      const text = done.message.content.map((c: any) => c.text ?? "").join(" ");
      expect(text).not.toMatch(/error_during_execution/);
    });

    it("does NOT break-early when stream has no tool_use blocks", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      // Text-only stream
      const lines = [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
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
            delta: { type: "text_delta", text: "Hello!" },
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
            usage: { output_tokens: 1 },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Hello!",
        }),
      ];

      for (const line of lines) {
        proc.stdout.write(line + "\n");
      }
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      // Process should NOT have been killed with SIGKILL immediately
      // It should only be killed via cleanupProcess after result (500ms grace)
      const killCalls = proc.kill.mock.calls;
      const sigkillBeforeResult = killCalls.filter(
        (call: any[]) => call[0] === "SIGKILL",
      );
      // If killed, it was only after the cleanup grace period, not at message_stop
      // The kill should only happen after we advance past the 500ms timer
      expect(sigkillBeforeResult).toHaveLength(0);

      // Now advance past cleanup timer
      vi.advanceTimersByTime(500);
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("does NOT break-early for internal Claude Code tools (ToolSearch, Task, etc.)", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Use weather tool" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      const lines = [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool_ts",
              name: "ToolSearch",
            },
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
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 5 },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "ok",
        }),
      ];

      for (const line of lines) {
        proc.stdout.write(line + "\n");
      }
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      // Process should NOT have been killed at message_stop (ToolSearch is internal)
      const killCalls = proc.kill.mock.calls;
      const sigkillBeforeResult = killCalls.filter(
        (call: any[]) => call[0] === "SIGKILL",
      );
      expect(sigkillBeforeResult).toHaveLength(0);

      vi.advanceTimersByTime(500);
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("does NOT break-early for pi-known tools inside sub-agents (parent_tool_use_id set)", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Run an agent" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      // Top-level: Agent tool_use (not pi-known, no break-early)
      // Then sub-agent uses Read (pi-known, but parent_tool_use_id is set)
      // Then sub-agent message_stop (should NOT trigger break-early)
      // Then top-level text response and message_stop (no tool_use, no break-early)
      const lines = [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
          },
          parent_tool_use_id: null,
        }),
        // Top-level: Agent tool call
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "agent_1",
              name: "Agent",
            },
          },
          parent_tool_use_id: null,
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
          parent_tool_use_id: null,
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 5 },
          },
          parent_tool_use_id: null,
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
          parent_tool_use_id: null,
        }),
        // Sub-agent: Read tool (pi-known, but inside sub-agent)
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "read_1",
              name: "Read",
            },
          },
          parent_tool_use_id: "agent_1",
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
          parent_tool_use_id: "agent_1",
        }),
        // Top-level: final text response
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 20, output_tokens: 0 } },
          },
          parent_tool_use_id: null,
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          parent_tool_use_id: null,
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Agent found the code." },
          },
          parent_tool_use_id: null,
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
          parent_tool_use_id: null,
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 10 },
          },
          parent_tool_use_id: null,
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
          parent_tool_use_id: null,
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Agent found the code.",
        }),
      ];

      for (const line of lines) {
        proc.stdout.write(line + "\n");
      }
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      // Should NOT have been killed at any message_stop (no top-level pi-known tools)
      // The Read inside the sub-agent should be ignored for break-early
      const killBeforeResult = proc.kill.mock.calls.filter(
        (call: any[]) => call[0] === "SIGKILL",
      );
      expect(killBeforeResult).toHaveLength(0);

      // Should have received the final text response
      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const textEvents = mockStream._events.filter(
        (e: any) => e.type === "text_delta",
      );
      expect(textEvents.length).toBeGreaterThan(0);

      vi.advanceTimersByTime(500);
    });

    it("does NOT break-early when only user MCP tools are seen (not custom-tools)", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Use user MCP tool" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      const lines = [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool_3",
              name: "mcp__user-server__tool",
              input: "",
            },
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
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 5 },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "ok",
        }),
      ];

      for (const line of lines) {
        proc.stdout.write(line + "\n");
      }
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      // Process should NOT have been killed at message_stop (only user MCP tool)
      const killCalls = proc.kill.mock.calls;
      const sigkillBeforeResult = killCalls.filter(
        (call: any[]) => call[0] === "SIGKILL",
      );
      expect(sigkillBeforeResult).toHaveLength(0);

      // After cleanup grace period, process gets killed
      vi.advanceTimersByTime(500);
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    });
  });

  describe("subprocess error handling", () => {
    it("pushes done event when subprocess emits error (e.g. spawn failure)", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      // Emit process error (e.g. ENOENT from failed spawn)
      proc.emit("error", new Error("spawn ENOENT"));
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const doneEvent = mockStream._events.find(
        (e: any) => e.type === "done" && e.message,
      );
      expect(doneEvent).toBeDefined();
      expect(doneEvent.message.content).toBeDefined();
      expect(mockStream.end).toHaveBeenCalled();
    });

    it("pushes error event when subprocess crashes with non-zero exit code", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      // Emit close with non-zero exit code (no result written first)
      proc.emit("close", 1, null);
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const doneEvent = mockStream._events.find(
        (e: any) => e.type === "done" && e.message,
      );
      expect(doneEvent).toBeDefined();
      expect(doneEvent.message.content).toBeDefined();
      expect(mockStream.end).toHaveBeenCalled();
    });

    it("includes stderr in error event on crash", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      // Emit stderr data, then close with non-zero exit
      proc.stderr.emit("data", Buffer.from("segfault in libfoo.so"));
      proc.emit("close", 139, null);
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const doneEvent = mockStream._events.find(
        (e: any) => e.type === "done" && e.message,
      );
      expect(doneEvent).toBeDefined();
      expect(doneEvent.message.content).toBeDefined();
    });

    it("does not push error on normal close (code 0)", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      // Write result to stdout then close with code 0
      const lines = [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
      ];
      for (const line of lines) {
        proc.stdout.write(line + "\n");
      }
      proc.emit("close", 0, null);
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const errorEvent = mockStream._events.find(
        (e: any) => e.type === "error",
      );
      expect(errorEvent).toBeUndefined();
    });

    it("does not push error after break-early (broken flag)", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Read a file" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      // Simulate tool_use break-early sequence
      const lines = [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool_1",
              name: "Read",
              input: "",
            },
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
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 5 },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
        }),
      ];
      for (const line of lines) {
        proc.stdout.write(line + "\n");
      }
      await vi.advanceTimersByTimeAsync(50);

      // Now emit close with non-zero code (from SIGKILL)
      proc.emit("close", null, "SIGKILL");
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      // Should have done event but no error event
      const eventTypes = mockStream._events.map((e: any) => e.type);
      expect(eventTypes).toContain("done");
      expect(eventTypes).not.toContain("error");
    });
  });

  describe("inactivity timeout", () => {
    it("kills subprocess and pushes error after the inactivity window with no output", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      // Advance timers past the inactivity window without writing to stdout
      await vi.advanceTimersByTimeAsync(300_000);

      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const doneEvent = mockStream._events.find(
        (e: any) => e.type === "done" && e.message,
      );
      expect(doneEvent).toBeDefined();
      expect(doneEvent.message.content).toBeDefined();
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

      // Clean up - end stdout so readline closes
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);
    });

    it("resets timer on each stdout line", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      // Advance to 290s (inside the 300s window) then write a line
      await vi.advanceTimersByTimeAsync(290_000);

      // Write a stream event line
      proc.stdout.write(
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
          },
        }) + "\n",
      );
      await vi.advanceTimersByTimeAsync(0);

      // Advance another 290s (only 290s since last line) -- should NOT timeout
      await vi.advanceTimersByTimeAsync(290_000);

      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const doneEvent = mockStream._events.find(
        (e: any) => e.type === "done" && e.message,
      );
      expect(doneEvent).toBeUndefined();

      // Advance the rest of the window since the last line -- NOW should timeout
      await vi.advanceTimersByTimeAsync(10_000);

      const doneEvent2 = mockStream._events.find(
        (e: any) => e.type === "done" && e.message,
      );
      expect(doneEvent2).toBeDefined();
      expect(doneEvent2.message.content).toBeDefined();

      // Clean up
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);
    });

    it("clears timer on normal completion", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      // Write normal result to stdout
      const lines = [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
      ];
      for (const line of lines) {
        proc.stdout.write(line + "\n");
      }
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      // Advance past the window -- should NOT timeout since result was received
      await vi.advanceTimersByTimeAsync(300_000);

      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const errorEvents = mockStream._events.filter(
        (e: any) => e.type === "error",
      );
      expect(errorEvents).toHaveLength(0);
    });
  });

  describe("abort handler fix", () => {
    it("abort backstop sends SIGKILL not SIGTERM", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };
      const controller = new AbortController();

      streamViaCli(model, context, { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      controller.abort();
      // Let the interrupt grace elapse so the backstop fires.
      await vi.advanceTimersByTimeAsync(2100);

      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
      const sigTermCalls = proc.kill.mock.calls.filter(
        (call: any[]) => call[0] === "SIGTERM",
      );
      expect(sigTermCalls).toHaveLength(0);

      // Clean up
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);
    });
  });

  describe("abort signal already aborted", () => {
    it("winds down a pre-aborted signal via interrupt + backstop", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };
      const controller = new AbortController();
      controller.abort(); // Abort BEFORE calling streamViaCli

      streamViaCli(model, context, { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(2100);

      const proc = (spawn as any).mock.results[0].value;
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

      // Clean up
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);
    });
  });

  describe("MCP config with custom tool results", () => {
    it("keeps MCP config even when conversation ends with custom tool result", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [
          { role: "user", content: "deploy it" },
          {
            role: "assistant",
            content: [
              { type: "toolCall", name: "deploy", arguments: { env: "prod" } },
            ],
          },
          {
            role: "toolResult",
            content: "Deployed successfully",
            toolName: "deploy",
          },
        ],
      };

      streamViaCli(model, context, {
        mcpConfigPath: "/tmp/mcp.json",
      } as any);
      await vi.advanceTimersByTimeAsync(0);

      const args = (spawn as any).mock.calls[0][1] as string[];
      // MCP config should always be passed so consecutive MCP tool calls work
      expect(args).toContain("--mcp-config");

      // Clean up
      const proc = (spawn as any).mock.results[0].value;
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);
    });

    it("does NOT suppress MCP config when conversation ends with user message", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };

      streamViaCli(model, context, {
        mcpConfigPath: "/tmp/mcp.json",
      } as any);
      await vi.advanceTimersByTimeAsync(0);

      const args = (spawn as any).mock.calls[0][1] as string[];
      expect(args).toContain("--mcp-config");

      // Clean up
      const proc = (spawn as any).mock.results[0].value;
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);
    });
  });

  describe("effectiveReason override logic", () => {
    it("overrides toolUse stopReason to stop when no pi-known tool calls in content", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      // Stream a sequence where Claude calls a user MCP tool (not pi-known)
      // The event bridge filters it out so content has no toolCall items
      const lines = [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool_user",
              name: "mcp__user-server__tool",
            },
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
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 5 },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
      ];
      for (const line of lines) {
        proc.stdout.write(line + "\n");
      }
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      // Advance past cleanup
      vi.advanceTimersByTime(500);

      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const doneEvent = mockStream._events.find((e: any) => e.type === "done");
      expect(doneEvent).toBeDefined();
      // Reason should be overridden to "stop" (not "toolUse")
      expect(doneEvent.reason).toBe("stop");
      expect(doneEvent.message.stopReason).toBe("stop");
    });

    it("keeps toolUse stopReason when a handoff tool call is present", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Read a file" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      // Stream a sequence where Claude calls a HANDOFF tool
      const lines = [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool_h",
              name: "mcp__custom-tools__search",
              input: "",
            },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: '{"query":"x"}',
            },
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
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 5 },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
        }),
      ];
      for (const line of lines) {
        proc.stdout.write(line + "\n");
      }
      await vi.advanceTimersByTimeAsync(0);
      // The handoff interrupt ends the turn with an expected
      // error_during_execution result envelope.
      proc.stdout.write(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          usage: { input_tokens: 10, output_tokens: 5 },
        }) + "\n",
      );
      await vi.advanceTimersByTimeAsync(100);

      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const doneEvent = mockStream._events.find((e: any) => e.type === "done");
      expect(doneEvent).toBeDefined();
      expect(doneEvent.reason).toBe("toolUse");
      expect(doneEvent.message.stopReason).toBe("toolUse");

      // Clean up
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);
    });

    it("handles undefined output.content without crashing", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Hello" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      // Stream a minimal sequence with no content blocks — just message_start,
      // message_delta with stop_reason, message_stop, and result.
      // This produces output.content = undefined in the event bridge.
      const lines = [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 0 },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
      ];
      for (const line of lines) {
        proc.stdout.write(line + "\n");
      }
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      vi.advanceTimersByTime(500);

      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const doneEvent = mockStream._events.find((e: any) => e.type === "done");
      expect(doneEvent).toBeDefined();
      // Should not crash — stopReason should be "stop" (end_turn maps to stop)
      expect(doneEvent.reason).toBe("stop");
    });

    it("passes through length stopReason unchanged", async () => {
      const model = mockModels[0] as any;
      const context = {
        messages: [{ role: "user", content: "Write a very long essay" }],
      };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;

      const lines = [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { usage: { input_tokens: 10, output_tokens: 0 } },
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
            delta: { type: "text_delta", text: "Long text..." },
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
            delta: { stop_reason: "max_tokens" },
            usage: { output_tokens: 8192 },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_stop" },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
      ];
      for (const line of lines) {
        proc.stdout.write(line + "\n");
      }
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      vi.advanceTimersByTime(500);

      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const doneEvent = mockStream._events.find((e: any) => e.type === "done");
      expect(doneEvent).toBeDefined();
      expect(doneEvent.reason).toBe("length");
      expect(doneEvent.message.stopReason).toBe("length");
    });
  });

  describe("session mapping: one CLI session per pi session", () => {
    // Observer mode resumes the CLI session recorded in the sidecar map
    // (PI_CLAUDE_CLI_STATE_DIR), and reimports on anything suspicious.
    const os = require("node:os");
    const fsx = require("node:fs");
    const pathx = require("node:path");
    let stateDir: string;

    beforeEach(() => {
      stateDir = fsx.mkdtempSync(pathx.join(os.tmpdir(), "pcc-state-"));
      process.env.PI_CLAUDE_CLI_STATE_DIR = stateDir;
      // Pin the mode: which flag carries the prompt is asserted below, and an
      // ambient PI_CLAUDE_CLI_SYSTEM_PROMPT would otherwise decide it.
      process.env.PI_CLAUDE_CLI_SYSTEM_PROMPT = "claude";
    });

    afterEach(() => {
      delete process.env.PI_CLAUDE_CLI_STATE_DIR;
      delete process.env.PI_CLAUDE_CLI_SYSTEM_PROMPT;
      try {
        fsx.rmSync(stateDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    const writeMap = (map: Record<string, string>) =>
      fsx.writeFileSync(
        pathx.join(stateDir, "session-map.json"),
        JSON.stringify(map),
      );
    const readMapFile = (): Record<string, string> =>
      JSON.parse(
        fsx.readFileSync(pathx.join(stateDir, "session-map.json"), "utf-8"),
      );

    const drain = async () => {
      const proc = (spawn as any).mock.results[0].value;
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);
    };

    const ourAssistant = {
      role: "assistant",
      content: "Hi",
      provider: "pi-claude-cli",
      api: "pi-claude-cli",
    };

    it("resumes the mapped CLI session with a delta prompt, and still sends the system prompt", async () => {
      writeMap({ "pi-sess-1": "cli-sess-9" });
      const context = {
        systemPrompt: "SYS",
        messages: [
          { role: "user", content: "FIRST" },
          ourAssistant,
          { role: "user", content: "SECOND" },
        ],
      };

      streamViaCli(mockModels[0] as any, context, {
        sessionId: "pi-sess-1",
      } as any);
      await vi.advanceTimersByTimeAsync(0);

      const args = (spawn as any).mock.calls[0][1] as string[];
      expect(args).toContain("--resume");
      expect(args[args.indexOf("--resume") + 1]).toBe("cli-sess-9");
      expect(args).not.toContain("--session-id");
      // The CLI drops --system-prompt on resume, so it must be re-sent every
      // turn or the session silently reverts to Claude Code's own prompt.
      expect(args).toContain("--append-system-prompt");

      const proc = (spawn as any).mock.results[0].value;
      const sent = JSON.parse(
        (proc.stdin.write as any).mock.calls[0][0] as string,
      ).message.content as string;
      // Delta only: the CLI session already holds FIRST and the reply.
      expect(sent).toContain("SECOND");
      expect(sent).not.toContain("FIRST");
      await drain();
    });

    it("replays the stored prompt verbatim on resume, ignoring a drifted rebuild", async () => {
      // Cache warmth depends on byte-identical bytes, and a rebuild is not
      // byte-stable: buildSystemPrompt appends a tool-results paragraph as
      // soon as history holds a toolResult. The stored copy must win.
      writeMap({ "pi-sess-1": "cli-sess-9" });
      fsx.mkdirSync(pathx.join(stateDir, "sysprompt"), { recursive: true });
      fsx.writeFileSync(
        pathx.join(stateDir, "sysprompt", "cli-sess-9.txt"),
        "ORIGINAL PROMPT",
      );

      streamViaCli(
        mockModels[0] as any,
        {
          systemPrompt: "DRIFTED PROMPT",
          messages: [
            { role: "user", content: "FIRST" },
            ourAssistant,
            { role: "toolResult", content: "r" },
            { role: "user", content: "SECOND" },
          ],
        },
        { sessionId: "pi-sess-1" } as any,
      );
      await vi.advanceTimersByTimeAsync(0);

      const args = (spawn as any).mock.calls[0][1] as string[];
      const promptFile = args[args.indexOf("--append-system-prompt") + 1];
      expect(fsx.readFileSync(promptFile, "utf-8")).toBe("ORIGINAL PROMPT");
      await drain();
    });

    it("stores the created prompt so the next turn can replay it", async () => {
      streamViaCli(
        mockModels[0] as any,
        {
          systemPrompt: "SYS-ONE",
          messages: [{ role: "user", content: "Hello" }],
        },
        { sessionId: "pi-sess-store" } as any,
      );
      await vi.advanceTimersByTimeAsync(0);

      const args = (spawn as any).mock.calls[0][1] as string[];
      const cliId = args[args.indexOf("--session-id") + 1];
      const stored = fsx.readFileSync(
        pathx.join(stateDir, "sysprompt", `${cliId}.txt`),
        "utf-8",
      );
      const promptFile = args[args.indexOf("--append-system-prompt") + 1];
      // Byte-identical to what this very spawn sent.
      expect(stored).toBe(fsx.readFileSync(promptFile, "utf-8"));
      expect(stored).toContain("SYS-ONE");
      await drain();
    });

    it("creates a fresh CLI session with a provider-minted id on the first turn", async () => {
      const context = { messages: [{ role: "user", content: "Hello" }] };

      streamViaCli(mockModels[0] as any, context, {
        sessionId: "pi-sess-2",
      } as any);
      await vi.advanceTimersByTimeAsync(0);

      const args = (spawn as any).mock.calls[0][1] as string[];
      expect(args).not.toContain("--resume");
      expect(args).toContain("--session-id");
      const cliId = args[args.indexOf("--session-id") + 1];
      // Never pi's id: forks reuse pi ids, and the CLI refuses a seen id.
      expect(cliId).not.toBe("pi-sess-2");
      expect(cliId).toMatch(/^[0-9a-f-]{36}$/);
      // The mapping is recorded for the next turn to resume.
      expect(readMapFile()["pi-sess-2"]).toBe(cliId);
      await drain();
    });

    it("reimports when a foreign-provider turn followed our last one (stale CLI session)", async () => {
      writeMap({ "pi-sess-3": "cli-sess-old" });
      const context = {
        messages: [
          { role: "user", content: "FIRST" },
          ourAssistant,
          { role: "user", content: "SECOND" },
          {
            role: "assistant",
            content: "from GLM",
            provider: "amazon-bedrock",
          },
          { role: "user", content: "THIRD" },
        ],
      };

      streamViaCli(mockModels[0] as any, context, {
        sessionId: "pi-sess-3",
      } as any);
      await vi.advanceTimersByTimeAsync(0);

      const args = (spawn as any).mock.calls[0][1] as string[];
      expect(args).not.toContain("--resume");
      expect(args).toContain("--session-id");

      // Full history import, not a delta.
      const proc = (spawn as any).mock.results[0].value;
      const sent = JSON.parse(
        (proc.stdin.write as any).mock.calls[0][0] as string,
      ).message.content as string;
      expect(sent).toContain("FIRST");
      expect(sent).toContain("THIRD");
      await drain();
    });

    it("creates a fresh session when no sessionId option is given", async () => {
      const context = {
        messages: [
          { role: "user", content: "Hello" },
          ourAssistant,
          { role: "user", content: "Follow-up" },
        ],
      };

      streamViaCli(mockModels[0] as any, context);
      await vi.advanceTimersByTimeAsync(0);

      const args = (spawn as any).mock.calls[0][1] as string[];
      expect(args).not.toContain("--resume");
      expect(args).toContain("--session-id");
      await drain();
    });

    it("clears the mapping when a turn fails, so the next turn reimports", async () => {
      writeMap({ "pi-sess-4": "cli-sess-4" });
      const context = {
        messages: [
          { role: "user", content: "FIRST" },
          ourAssistant,
          { role: "user", content: "SECOND" },
        ],
      };

      streamViaCli(mockModels[0] as any, context, {
        sessionId: "pi-sess-4",
      } as any);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;
      proc.stdout.write(
        JSON.stringify({ type: "result", subtype: "error", error: "boom" }) +
          "\n",
      );
      await vi.advanceTimersByTimeAsync(0);
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      expect(readMapFile()["pi-sess-4"]).toBeUndefined();
    });
  });

  describe("non-success result surfacing", () => {
    function findErrorText(): string {
      const mockStream = MockAssistantMessageEventStream.mock.instances[0];
      const doneEvent = mockStream._events.find(
        (e: any) => e.type === "done" && e.message,
      );
      expect(doneEvent).toBeDefined();
      return (doneEvent.message.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
    }

    it("surfaces result.subtype = 'error_during_execution' as an error", async () => {
      const model = mockModels[0] as any;
      const context = { messages: [{ role: "user", content: "hi" }] };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;
      proc.stdout.write(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          errors: ["No conversation found with session ID: sess-xyz"],
        }) + "\n",
      );
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      expect(findErrorText()).toMatch(/No conversation found/);
    });

    it("surfaces result with is_error: true as an error", async () => {
      const model = mockModels[0] as any;
      const context = { messages: [{ role: "user", content: "hi" }] };

      streamViaCli(model, context);
      await vi.advanceTimersByTimeAsync(0);

      const proc = (spawn as any).mock.results[0].value;
      proc.stdout.write(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          error: "boom",
        }) + "\n",
      );
      proc.stdout.end();
      await vi.advanceTimersByTimeAsync(100);

      expect(findErrorText()).toMatch(/boom/);
    });
  });
});
