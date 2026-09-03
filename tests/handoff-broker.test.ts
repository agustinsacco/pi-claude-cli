import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh socket address per test: a unix socket, or a named pipe on Windows. */
function testSocketPath(tag: string): string {
  const name = `pcc-broker-${tag}-${process.pid}-${Date.now()}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${name}`
    : join(tmpdir(), `${name}.sock`);
}
import {
  dispatchHandoffCall,
  registerHandoffTarget,
  unregisterHandoffTarget,
  startHandoffBroker,
  stopHandoffBroker,
  resetHandoffBrokerForTests,
  NO_TARGET_MESSAGE,
  defaultSocketPath,
} from "../src/handoff-broker";
import type { HandoffCall, HandoffResult } from "../src/handoff-broker";

describe("handoff broker", () => {
  beforeEach(() => resetHandoffBrokerForTests());
  afterEach(() => stopHandoffBroker());

  it("routes a call to the target registered for its CLI session", () => {
    const received: HandoffCall[] = [];
    registerHandoffTarget("s1", { onHandoffCall: (c) => received.push(c) });
    const answers: HandoffResult[] = [];
    const ok = dispatchHandoffCall("s1", {
      toolUseId: "t1",
      name: "search",
      arguments: { q: "x" },
      respond: (r) => answers.push(r),
    });
    expect(ok).toBe(true);
    expect(received[0].name).toBe("search");
    expect(answers).toHaveLength(0);
  });

  it("answers a call for an unknown session with an error so the CLI never hangs", () => {
    const answers: HandoffResult[] = [];
    const ok = dispatchHandoffCall("nobody", {
      toolUseId: "t1",
      name: "search",
      arguments: {},
      respond: (r) => answers.push(r),
    });
    expect(ok).toBe(false);
    expect(answers[0].isError).toBe(true);
    expect((answers[0].content[0] as any).text).toBe(NO_TARGET_MESSAGE);
  });

  it("unregister is scoped to the target that registered", () => {
    const a = { onHandoffCall: vi.fn() };
    const b = { onHandoffCall: vi.fn() };
    registerHandoffTarget("s1", a);
    registerHandoffTarget("s1", b);
    unregisterHandoffTarget("s1", a); // a no longer owns the slot: no-op
    dispatchHandoffCall("s1", {
      toolUseId: "t",
      name: "n",
      arguments: {},
      respond: () => {},
    });
    expect(b.onHandoffCall).toHaveBeenCalled();
  });

  it("a call that throws inside the target is answered with an error", () => {
    registerHandoffTarget("s1", {
      onHandoffCall: () => {
        throw new Error("boom");
      },
    });
    const answers: HandoffResult[] = [];
    dispatchHandoffCall("s1", {
      toolUseId: "t",
      name: "n",
      arguments: {},
      respond: (r) => answers.push(r),
    });
    expect(answers[0].isError).toBe(true);
    expect((answers[0].content[0] as any).text).toContain("boom");
  });

  it("uses a unix socket in tmpdir, or a named pipe on Windows", () => {
    const p = defaultSocketPath();
    if (process.platform === "win32")
      expect(p.startsWith("\\\\.\\pipe\\")).toBe(true);
    else expect(p.startsWith(tmpdir())).toBe(true);
  });

  it("serves the wire protocol over the socket: one NDJSON call, one NDJSON result", async () => {
    const path = testSocketPath("test");
    const socketPath = await startHandoffBroker(path);
    expect(socketPath).toBe(path);
    registerHandoffTarget("s1", {
      onHandoffCall: (c) => {
        expect(c.toolUseId).toBe("t9");
        expect(c.arguments).toEqual({ path: "." });
        c.respond({ content: [{ type: "text", text: "listing" }] });
      },
    });
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(path);
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("connect", () =>
        sock.write(
          JSON.stringify({
            type: "call",
            session: "s1",
            toolUseId: "t9",
            name: "ls",
            arguments: { path: "." },
          }) + "\n",
        ),
      );
      sock.on("data", (d) => (buf += d));
      sock.on("end", () => resolve(buf));
      sock.on("error", reject);
    });
    expect(JSON.parse(reply.trim())).toEqual({
      type: "result",
      content: [{ type: "text", text: "listing" }],
    });
    // Starting again returns the same path without rebinding.
    expect(await startHandoffBroker(path)).toBe(path);
  });

  it("answers a malformed request with an error", async () => {
    const path = testSocketPath("bad");
    await startHandoffBroker(path);
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(path);
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("connect", () => sock.write("not json\n"));
      sock.on("data", (d) => (buf += d));
      sock.on("end", () => resolve(buf));
      sock.on("error", reject);
    });
    expect(JSON.parse(reply.trim()).isError).toBe(true);
  });
});
