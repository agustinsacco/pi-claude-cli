/**
 * Real pi, real Claude CLI: every request after the first reads the cached
 * prefix through the four events that used to re-import the conversation:
 * a message sent while a tool runs, a system-prompt section change, an
 * extension's own model call during a tool, and an aborted reply.
 *
 * Runs only with PI_OWNED_LIVE=1 and an authenticated Claude Code. Needs a pi
 * with `context_with_system` (1.x): point PI_LIVE_PI_CLI at its cli.js.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { spawnCounter } from "./fixtures/spawn-counter";
import { expect, it } from "vitest";

const FIXTURE = `
let flag = "red";
export default function (pi) {
  pi.registerCommand("flip", {
    description: "change the fixture section",
    async handler() { flag = "green"; },
  });
  pi.on("context_with_system", (event) => {
    const head = event.messages.find((m) => m.role === "system");
    if (head) head.sections = { ...head.sections, fixture: "<fixture>colour=" + flag + "</fixture>" };
    return { messages: event.messages };
  });
  pi.registerTool({
    name: "side_query",
    label: "side query",
    description: "Ask the session model a side question, as pi-web-access does.",
    parameters: { type: "object", properties: {} },
    async execute(_id, _params, signal, _update, ctx) {
      const reply = await ctx.modelRegistry.complete(
        ctx.model,
        { messages: [{ role: "user", content: "Reply with just: SIDE-OK", timestamp: Date.now() }] },
        { sessionId: ctx.sessionManager.getSessionId(), cacheRetention: "none", signal },
      );
      const text = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
`;

/** Long enough that every model caches it (the minimum is a few thousand tokens). */
const NOTES = Array.from(
  { length: 500 },
  (_, i) =>
    `Reference note ${i}: entries are stable, ordered, and never need to be quoted.`,
).join("\n");

it.skipIf(process.env.PI_OWNED_LIVE !== "1")(
  "keeps the cached prefix through steering, a section change, a side call and an abort",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-cache-live-"));
    const fixture = join(cwd, "fixture.ts");
    writeFileSync(fixture, FIXTURE);
    const spawns = spawnCounter(cwd);
    const client = new RpcClient({
      cliPath:
        process.env.PI_LIVE_PI_CLI ??
        resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      cwd,
      // The suite defaults to the legacy policy (tests/setup-env.ts).
      env: {
        PI_CODING_AGENT_DIR: join(cwd, "agent"),
        PI_CLAUDE_CLI_CONTEXT: "pi",
        PATH: `${spawns.bin}:${process.env.PATH}`,
      },
      provider: "pi-claude-cli",
      model: process.env.PI_LIVE_MODEL ?? "claude-opus-4-6",
      args: [
        "--no-session",
        "-ne",
        "-e",
        resolve("index.ts"),
        "-e",
        fixture,
        "--tools",
        "bash,side_query",
        "--system-prompt",
        `Follow the user's instructions exactly and be brief.\n\n${NOTES}`,
      ],
    });
    const waitFor = (type: string, name?: string) =>
      new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`no ${type}`)), 90_000);
        const off = client.onEvent((e: any) => {
          if (e.type === type && (!name || e.toolName === name)) {
            clearTimeout(timer);
            off();
            done();
          }
        });
      });
    const trace = process.env.PI_LIVE_TRACE;
    try {
      await client.start();
      if (trace)
        client.onEvent((e: any) =>
          writeFileSync(trace, `${e.type} ${e.toolName ?? ""}\n`, {
            flag: "a",
          }),
        );
      await client.setAutoRetry(false);

      // 1. Steering: a message sent while the tool runs.
      const running = waitFor("tool_execution_start", "bash");
      await client.prompt(
        "Run the bash command `sleep 5; echo READY` once, then reply with its output.",
      );
      await running;
      await client.steer("Also end your reply with the word BANANA.");
      await client.waitForIdle(120_000);
      expect(await client.getLastAssistantText()).toContain("BANANA");

      // 2. A section of the system prompt changes between turns.
      await client.prompt("/flip");
      await client.promptAndWait(
        "What colour does the fixture section give now? One word.",
        undefined,
        90_000,
      );
      expect((await client.getLastAssistantText())?.toLowerCase()).toContain(
        "green",
      );

      // 3. An extension's own model call while its tool runs.
      await client.promptAndWait(
        "Call side_query once and reply with exactly what it returned.",
        undefined,
        120_000,
      );
      expect(await client.getLastAssistantText()).toContain("SIDE-OK");

      // 4. An aborted reply, then the next turn.
      const streaming = waitFor("message_update");
      await client.prompt("Count from 1 to 300, one number per line.");
      await streaming;
      await client.abort(); // resolves once pi is idle again
      await client.promptAndWait("Reply with just: ok", undefined, 90_000);

      const replies = (await client.getMessages()).filter(
        (m: any) => m.role === "assistant" && m.stopReason !== "aborted",
      ) as any[];
      const rows = replies.map((m) => {
        const u = m.usage;
        const prompt = u.input + u.cacheRead + u.cacheWrite;
        return {
          prompt,
          read: u.cacheRead,
          write: u.cacheWrite,
          w1h: u.cacheWrite1h,
        };
      });
      console.table(rows);
      // One process for the session and one for the side call. A small
      // conversation hides a re-import in the ratios below (the static prefix
      // still reads), so the process count is the real check.
      expect(spawns.count()).toBe(2);
      // The first request writes the prefix; every later one reads it.
      expect(rows[0].w1h ?? 0).toBeGreaterThan(0);
      for (const row of rows.slice(1)) {
        expect(row.read / row.prompt).toBeGreaterThan(0.6);
      }
    } catch (error) {
      console.error(client.getStderr());
      throw error;
    } finally {
      await client.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  600_000,
);
