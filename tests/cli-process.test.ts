import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  CliProcess,
  parkCliProcess,
  takeParkedCliProcess,
  parkedCliProcessCount,
  resetCliProcessesForTests,
  addUsage,
  subUsage,
  maxUsage,
} from "../src/cli-process";
import {
  dispatchHandoffCall,
  resetHandoffBrokerForTests,
} from "../src/handoff-broker";
import type { HandoffCall, HandoffResult } from "../src/handoff-broker";
import type { NdjsonMessage } from "../src/types";

function fakeProc() {
  const proc: any = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.stdout = new PassThrough();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  return proc;
}

function make(proc = fakeProc(), allowHandoff = true) {
  const cli = new CliProcess(proc, {
    cliSessionId: "cli-1",
    signature: "sig",
    allowHandoff,
    getStderr: () => "",
  });
  return { proc, cli };
}

function sink() {
  const messages: NdjsonMessage[] = [];
  const closes: Array<number | null> = [];
  return {
    messages,
    closes,
    s: {
      onMessage: (m: NdjsonMessage) => messages.push(m),
      onClose: (c: number | null) => closes.push(c),
      onError: vi.fn(),
    },
  };
}

function call(
  id: string,
  name = "search",
): { call: HandoffCall; answers: HandoffResult[] } {
  const answers: HandoffResult[] = [];
  return {
    answers,
    call: {
      toolUseId: id,
      name,
      arguments: {},
      respond: (r) => answers.push(r),
    },
  };
}

describe("CliProcess", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCliProcessesForTests();
    resetHandoffBrokerForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers lines while detached and replays them to the next episode in order", async () => {
    const { proc, cli } = make();
    proc.stdout.write(
      JSON.stringify({ type: "system", subtype: "init" }) + "\n",
    );
    proc.stdout.write(
      JSON.stringify({ type: "assistant", message: { content: [] } }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    const a = sink();
    cli.attach(a.s);
    expect(a.messages.map((m) => m.type)).toEqual(["system", "assistant"]);
    // Live lines go straight through once attached.
    proc.stdout.write(JSON.stringify({ type: "user", message: {} }) + "\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(a.messages.map((m) => m.type)).toEqual([
      "system",
      "assistant",
      "user",
    ]);
  });

  it("answers permission requests itself, attached or not, and allows handoff tools when proxying", async () => {
    const { proc, cli } = make();
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "r1",
        request: {
          subtype: "can_use_tool",
          tool_name: "mcp__custom-tools__x",
          input: { a: 1 },
        },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    const written = JSON.parse(proc.stdin.write.mock.calls[0][0]);
    expect(written.response.request_id).toBe("r1");
    expect(written.response.response.behavior).toBe("allow");
    // The request is not replayed to a later episode: it was already answered.
    const a = sink();
    cli.attach(a.s);
    expect(a.messages).toHaveLength(0);
  });

  it("denies handoff tools when the proxy is off (legacy interrupt path)", async () => {
    const { proc } = make(fakeProc(), false);
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "r1",
        request: {
          subtype: "can_use_tool",
          tool_name: "mcp__custom-tools__x",
          input: {},
        },
      }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    const written = JSON.parse(proc.stdin.write.mock.calls[0][0]);
    expect(written.response.response.behavior).toBe("deny");
  });

  it("routes a tools/call that arrives BEFORE pi's result, and answers when it lands", () => {
    const { cli } = make();
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    const c = call("t1");
    expect(dispatchHandoffCall("cli-1", c.call)).toBe(true);
    expect(c.answers).toHaveLength(0);
    expect(cli.canContinueHandoff(["t1"])).toBe(true);
    cli.deliverHandoffResult("t1", {
      content: [{ type: "text", text: "done" }],
    });
    expect(c.answers).toEqual([{ content: [{ type: "text", text: "done" }] }]);
  });

  it("holds pi's result when it arrives BEFORE the tools/call, and answers on arrival", () => {
    const { cli } = make();
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    expect(cli.canContinueHandoff(["t1"])).toBe(true);
    cli.deliverHandoffResult("t1", {
      content: [{ type: "text", text: "early" }],
    });
    const c = call("t1");
    dispatchHandoffCall("cli-1", c.call);
    expect(c.answers).toEqual([{ content: [{ type: "text", text: "early" }] }]);
  });

  it("refuses to continue a handoff for ids it never saw, or when no turn is active", () => {
    const { cli } = make();
    expect(cli.canContinueHandoff(["t1"])).toBe(false);
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    expect(cli.canContinueHandoff(["t1", "t2"])).toBe(false);
    expect(cli.canContinueHandoff([])).toBe(false);
  });

  it("matches an untagged call to the single awaited handoff, and refuses when ambiguous", () => {
    const { cli } = make();
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    const c = call("");
    dispatchHandoffCall("cli-1", c.call);
    cli.deliverHandoffResult("t1", { content: [{ type: "text", text: "ok" }] });
    expect(c.answers[0].content[0]).toEqual({ type: "text", text: "ok" });

    cli.noteHandoffToolUse("a");
    cli.noteHandoffToolUse("b");
    const d = call("");
    dispatchHandoffCall("cli-1", d.call);
    expect(d.answers[0].isError).toBe(true);
  });

  it("flips turnActive off before the episode sees the result, and fails calls left open", async () => {
    const { proc, cli } = make();
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    const c = call("t1");
    dispatchHandoffCall("cli-1", c.call);
    let activeAtResult: boolean | undefined;
    cli.attach({
      onMessage: (m) => {
        if (m.type === "result") activeAtResult = cli.turnActive;
      },
      onClose: () => {},
      onError: () => {},
    });
    proc.stdout.write(
      JSON.stringify({ type: "result", subtype: "success" }) + "\n",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(activeAtResult).toBe(false);
    expect(c.answers[0].isError).toBe(true);
  });

  it("retire on an idle process ends stdin, then SIGKILLs after the grace period", async () => {
    const { proc, cli } = make();
    const done = cli.retire();
    expect(proc.stdin.end).toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    proc.emit("close", null);
    await done;
    expect(cli.alive).toBe(false);
  });

  it("retire on a live turn interrupts first so the CLI can persist the turn", async () => {
    const { proc, cli } = make();
    cli.writeUser("go");
    void cli.retire();
    const written = proc.stdin.write.mock.calls
      .map((c: any) => String(c[0]))
      .join("");
    expect(written).toContain('"interrupt"');
    expect(proc.stdin.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(proc.stdin.end).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("a retired process answers new tools/call requests with an error", () => {
    const { cli } = make();
    cli.writeUser("go");
    cli.noteHandoffToolUse("t1");
    void cli.retire();
    const c = call("t1");
    expect(dispatchHandoffCall("cli-1", c.call)).toBe(false);
    expect(c.answers[0].isError).toBe(true);
  });

  it("stdout EOF ends the attached episode but only the process close marks it dead", async () => {
    const { proc, cli } = make();
    const a = sink();
    cli.attach(a.s);
    proc.stdout.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.closes).toEqual([null]);
    expect(cli.alive).toBe(true);
    proc.emit("close", 0);
    expect(cli.alive).toBe(false);
    // Not reported twice.
    expect(a.closes).toEqual([null]);
  });

  describe("pool", () => {
    it("parks, takes, and forgets a process whose idle timer fires", async () => {
      const { proc, cli } = make();
      parkCliProcess("pi-1", cli, 1000);
      expect(parkedCliProcessCount()).toBe(1);
      expect(takeParkedCliProcess("pi-1")).toBe(cli);
      expect(parkedCliProcessCount()).toBe(0);

      parkCliProcess("pi-1", cli, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(parkedCliProcessCount()).toBe(0);
      expect(cli.retired).toBe(true);
      expect(proc.stdin.end).toHaveBeenCalled();
    });

    it("drops a parked process that exits on its own", () => {
      const { proc, cli } = make();
      parkCliProcess("pi-1", cli, 60_000);
      proc.emit("close", 0);
      expect(takeParkedCliProcess("pi-1")).toBeUndefined();
    });

    it("parking a second process for the same session retires the first", () => {
      const a = make();
      const b = make();
      parkCliProcess("pi-1", a.cli, 60_000);
      parkCliProcess("pi-1", b.cli, 60_000);
      expect(a.cli.retired).toBe(true);
      expect(takeParkedCliProcess("pi-1")).toBe(b.cli);
    });
  });

  describe("usage arithmetic", () => {
    const u = (a: number, b: number, c: number, d: number) => ({
      input_tokens: a,
      output_tokens: b,
      cache_read_input_tokens: c,
      cache_creation_input_tokens: d,
    });
    it("adds, subtracts with a zero floor, and takes component-wise max", () => {
      expect(addUsage(u(1, 2, 3, 4), u(10, 20, 30, 40))).toEqual(
        u(11, 22, 33, 44),
      );
      expect(subUsage(u(1, 20, 3, 40), u(10, 2, 30, 4))).toEqual(
        u(0, 18, 0, 36),
      );
      expect(maxUsage(u(1, 20, 3, 40), u(10, 2, 30, 4))).toEqual(
        u(10, 20, 30, 40),
      );
    });
  });
});
