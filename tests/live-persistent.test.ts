/**
 * LIVE: the persistent CLI process against the real Claude CLI. Spends real
 * tokens; gated on PI_CLAUDE_CLI_LIVE=1 like tests/live-observer.test.ts.
 *
 *   PI_CLAUDE_CLI_LIVE=1 npx vitest run tests/live-persistent.test.ts
 *
 * Proves the two cache properties 0.7.0 exists for:
 * 1. a custom-tool handoff continues on the SAME process (one MCP connect for
 *    the whole turn) and the continuation reads its prefix from cache;
 * 2. a git commit between two user turns does not re-bill the context,
 *    because the CLI's system prompt (git snapshot included) is built once.
 * And, for contrast, that the pre-0.7.0 path (fresh process per turn) does
 * re-bill it after the same commit.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { streamViaCli } from "../src/provider";
import { startHandoffBroker, stopHandoffBroker } from "../src/handoff-broker";
import { retireAllCliProcesses } from "../src/cli-process";

const LIVE = process.env.PI_CLAUDE_CLI_LIVE === "1";

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

function runTurn(context: any, options: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const stream = streamViaCli(model, context, options);
    const events: any[] = [];
    (async () => {
      for await (const ev of stream as any) {
        events.push(ev);
        if (ev.type === "done") return resolve({ done: ev, events });
        if (ev.type === "error") return reject(new Error(String(ev.error)));
      }
      reject(new Error("stream ended without done"));
    })().catch(reject);
  });
}

const ourAssistant = (content: any) => ({
  role: "assistant",
  content,
  provider: "pi-claude-cli",
  api: "pi-claude-cli",
});

describe.skipIf(!LIVE)("live: persistent CLI process", () => {
  let cwd: string;
  let stateDir: string;
  let schemaPath: string;
  let socketPath: string;

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "pcc-live-persist-"));
    execSync("git init -q && git commit -q --allow-empty -m init", { cwd });
    stateDir = mkdtempSync(join(tmpdir(), "pcc-live-state-"));
    process.env.PI_CLAUDE_CLI_STATE_DIR = stateDir;
    process.env.PI_CLAUDE_CLI_STRICT_MCP = "1";
    schemaPath = join(cwd, "schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify([
        {
          name: "echo",
          description: "Echo the given text back. Use it when asked to echo.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ]),
    );
    socketPath = await startHandoffBroker();
  }, 30_000);

  afterAll(async () => {
    await retireAllCliProcesses();
    stopHandoffBroker();
    delete process.env.PI_CLAUDE_CLI_STATE_DIR;
    delete process.env.PI_CLAUDE_CLI_STRICT_MCP;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  /**
   * CLI processes started for this cwd = MCP connection logs written for it.
   * The CLI mangles the cwd into a directory name; match on the unique tmp
   * basename rather than reimplementing the mangling.
   */
  function processCount(): number {
    const root = join(
      process.env.HOME ?? "",
      "Library",
      "Caches",
      "claude-cli-nodejs",
    );
    const key = cwd
      .split("/")
      .pop()!
      .replace(/[^A-Za-z0-9]/g, "-");
    try {
      const dir = readdirSync(root).find((d) => d.endsWith(key));
      if (!dir) return 0;
      return readdirSync(join(root, dir, "mcp-logs-custom-tools")).length;
    } catch {
      return 0;
    }
  }

  it("keeps one process through a handoff and across a commit, and stays cache-warm", async () => {
    const piSessionId = randomUUID();
    const opts = {
      sessionId: piSessionId,
      cwd,
      mcpConfig: { schemaPath, version: 1, handoffSocket: socketPath },
    };
    const before = processCount();

    // Turn 1: the model must call the custom tool → handoff to pi.
    const ctx1 = {
      systemPrompt: "You are terse.",
      messages: [
        {
          role: "user",
          content:
            'Call the mcp__custom-tools__echo tool with text "ping", then reply with only: ok',
        },
      ],
    };
    const t1 = await runTurn(ctx1, opts);
    expect(t1.done.reason).toBe("toolUse");
    const call = t1.done.message.content.find(
      (c: any) => c.type === "toolCall",
    );
    expect(call.name).toBe("echo");

    // pi "executes" the tool and calls back: same process, continuation.
    const ctx2 = {
      ...ctx1,
      messages: [
        ...ctx1.messages,
        ourAssistant(t1.done.message.content),
        {
          role: "toolResult",
          toolCallId: call.id,
          toolName: "echo",
          content: [{ type: "text", text: "ping" }],
          isError: false,
        },
      ],
    };
    const t2 = await runTurn(ctx2, opts);
    expect(t2.done.reason).toBe("stop");
    const afterHandoff = processCount();
    expect(afterHandoff - before).toBe(1); // ONE process so far
    // The continuation read the whole prefix back from cache.
    expect(t2.done.message.usage.cacheRead).toBeGreaterThan(10_000);
    expect(t2.done.message.usage.cacheWrite).toBeLessThan(2_000);

    // A commit between turns: with a live process the snapshot is not rebuilt.
    execSync("git commit -q --allow-empty -m between", { cwd });
    const ctx3 = {
      ...ctx1,
      messages: [
        ...ctx2.messages,
        ourAssistant(t2.done.message.content),
        { role: "user", content: "Reply with only: ok2" },
      ],
    };
    const t3 = await runTurn(ctx3, opts);
    expect(t3.done.reason).toBe("stop");
    expect(processCount() - before).toBe(1); // STILL one process
    expect(t3.done.message.usage.cacheRead).toBeGreaterThan(10_000);
    expect(t3.done.message.usage.cacheWrite).toBeLessThan(2_000);
    console.log(
      `[live] handoff continuation: read=${t2.done.message.usage.cacheRead} write=${t2.done.message.usage.cacheWrite}; ` +
        `turn after commit: read=${t3.done.message.usage.cacheRead} write=${t3.done.message.usage.cacheWrite}; processes=${processCount() - before}`,
    );
  }, 240_000);

  it("contrast: the pre-0.7.0 path (fresh process per turn) re-bills the context after a commit", async () => {
    process.env.PI_CLAUDE_CLI_KEEPALIVE_MS = "0";
    try {
      const piSessionId = randomUUID();
      const opts = {
        sessionId: piSessionId,
        cwd,
        mcpConfig: { schemaPath, version: 1, handoffSocket: socketPath },
      };
      const ctx1 = {
        systemPrompt: "You are terse.",
        messages: [{ role: "user", content: "Reply with only: ok" }],
      };
      const t1 = await runTurn(ctx1, opts);
      const ctx2 = {
        ...ctx1,
        messages: [
          ...ctx1.messages,
          ourAssistant(t1.done.message.content),
          { role: "user", content: "Reply with only: ok2" },
        ],
      };
      const t2 = await runTurn(ctx2, opts); // fresh process, nothing changed: warm
      expect(t2.done.message.usage.cacheWrite).toBeLessThan(2_000);
      execSync("git commit -q --allow-empty -m between2", { cwd });
      const ctx3 = {
        ...ctx1,
        messages: [
          ...ctx2.messages,
          ourAssistant(t2.done.message.content),
          { role: "user", content: "Reply with only: ok3" },
        ],
      };
      const t3 = await runTurn(ctx3, opts); // fresh process after a commit: the snapshot changed
      console.log(
        `[live] legacy after commit: read=${t3.done.message.usage.cacheRead} write=${t3.done.message.usage.cacheWrite}`,
      );
      expect(t3.done.message.usage.cacheWrite).toBeGreaterThan(2_000);
    } finally {
      delete process.env.PI_CLAUDE_CLI_KEEPALIVE_MS;
    }
  }, 240_000);
});
