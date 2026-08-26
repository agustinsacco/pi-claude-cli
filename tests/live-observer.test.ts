/**
 * LIVE observer-mode integration — spends real tokens against the real CLI.
 * Gated: runs only with PI_CLAUDE_CLI_LIVE=1. Not part of CI.
 *
 *   PI_CLAUDE_CLI_LIVE=1 npx vitest run tests/live-observer.test.ts
 *
 * Drives streamViaCli twice with one pi session id and asserts the second
 * turn RESUMES the same CLI session with native token economics.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { streamViaCli } from "../src/provider";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function runTurn(context: any, piSessionId: string, cwd: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const stream = streamViaCli(model, context, {
      sessionId: piSessionId,
      cwd,
    } as any);
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

describe.skipIf(!LIVE)("live observer mode (real CLI, real tokens)", () => {
  let ws: string;
  let stateDir: string;
  const piSessionId = `live-${Date.now()}`;

  beforeAll(() => {
    ws = realpathSync.native(mkdtempSync(join(tmpdir(), "live-obs-")));
    stateDir = mkdtempSync(join(tmpdir(), "live-state-"));
    process.env.PI_CLAUDE_CLI_STATE_DIR = stateDir;
    writeFileSync(join(ws, "one.txt"), "alpha word is TANGERINE\n");
    writeFileSync(join(ws, "two.txt"), "beta word is CORDUROY\n");
  });

  afterAll(() => {
    delete process.env.PI_CLAUDE_CLI_STATE_DIR;
    try {
      rmSync(ws, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it(
    "turn 1 native tools, turn 2 resumes the same CLI session cheaply",
    { timeout: 300_000 },
    async () => {
      // ---- turn 1: multi-tool, executed natively by the CLI ----
      const messages: any[] = [
        {
          role: "user",
          content:
            "Read one.txt then two.txt, one at a time. Then reply with exactly the two words separated by a space.",
        },
      ];
      const t1 = await runTurn({ messages }, piSessionId, ws);
      const text1 = t1.done.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");

      expect(text1).toContain("TANGERINE CORDUROY");
      // Built-ins are the CLI's: markers, never pi toolCalls.
      expect(text1).toContain("[Claude Code · Read");
      expect(
        t1.done.message.content.some((c: any) => c.type === "toolCall"),
      ).toBe(false);
      expect(t1.done.message.stopReason).toBe("stop");

      const map = JSON.parse(
        readFileSync(join(stateDir, "session-map.json"), "utf-8"),
      );
      const cliId = map[piSessionId];
      expect(cliId).toMatch(/^[0-9a-f-]{36}$/);

      // ---- turn 2: same pi session — must RESUME, not reimport ----
      messages.push({
        role: "assistant",
        content: t1.done.message.content,
        provider: "pi-claude-cli",
        api: "pi-claude-cli",
      });
      messages.push({
        role: "user",
        content: "What two words did you read earlier? Reply with only them.",
      });
      const t2 = await runTurn({ messages }, piSessionId, ws);
      const text2 = t2.done.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");

      expect(text2).toMatch(/TANGERINE/i);
      expect(text2).toMatch(/CORDUROY/i);
      // Same CLI session — the mapping did not change.
      const map2 = JSON.parse(
        readFileSync(join(stateDir, "session-map.json"), "utf-8"),
      );
      expect(map2[piSessionId]).toBe(cliId);

      // Native economics: the resumed turn reuses the cached prefix and
      // writes only the delta.
      const usage = t2.done.message.usage;
      expect(usage.cacheRead).toBeGreaterThan(5000);
      expect(usage.cacheWrite).toBeLessThan(2000);

      // And the CLI session file carries zero synthetic filler.
      const { execSync } = await import("node:child_process");
      const file = execSync(
        `find "${process.env.HOME}/.claude/projects" -name "${cliId}.jsonl" | head -1`,
      )
        .toString()
        .trim();
      expect(file).toBeTruthy();
      const raw = readFileSync(file, "utf-8");
      expect(raw).not.toContain("No response requested");
    },
  );
});

describe.skipIf(!LIVE)("live handoff: custom pi tool round-trip", () => {
  let ws: string;
  let stateDir: string;
  let mcpConfigPath: string;
  const piSessionId = `live-handoff-${Date.now()}`;

  beforeAll(() => {
    ws = realpathSync.native(mkdtempSync(join(tmpdir(), "live-ho-")));
    stateDir = mkdtempSync(join(tmpdir(), "live-ho-state-"));
    process.env.PI_CLAUDE_CLI_STATE_DIR = stateDir;
    // Advertise one custom tool through the real schema-only MCP server.
    const schemas = join(ws, "schemas.json");
    writeFileSync(
      schemas,
      JSON.stringify([
        {
          name: "fleet_status",
          description:
            "Report the status of the running agent fleet. The only way to get fleet status.",
          inputSchema: { type: "object", properties: {} },
        },
      ]),
    );
    const server = join(__dirname, "..", "src", "mcp-schema-server.cjs");
    mcpConfigPath = join(ws, "mcp.json");
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          "custom-tools": { command: "node", args: [server, schemas] },
        },
      }),
    );
  });

  afterAll(() => {
    delete process.env.PI_CLAUDE_CLI_STATE_DIR;
    try {
      rmSync(ws, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function runTurnWithMcp(context: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const stream = streamViaCli(model, context, {
        sessionId: piSessionId,
        cwd: ws,
        mcpConfigPath,
      } as any);
      (async () => {
        for await (const ev of stream as any) {
          if (ev.type === "done") return resolve(ev);
          if (ev.type === "error") return reject(new Error(String(ev.error)));
        }
        reject(new Error("stream ended without done"));
      })().catch(reject);
    });
  }

  it(
    "interrupts on the custom tool, pi executes, resume delivers the result",
    { timeout: 300_000 },
    async () => {
      // ---- turn 1: the model must call the handoff tool ----
      const messages: any[] = [
        {
          role: "user",
          content:
            "Use the fleet_status tool, then report the fleet status to me in one line.",
        },
      ];
      const t1 = await runTurnWithMcp({ messages });

      // The turn ended as a pi tool call, not an error and not a kill.
      expect(t1.reason).toBe("toolUse");
      const calls = t1.message.content.filter(
        (c: any) => c.type === "toolCall",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("fleet_status");

      // ---- pi "executes" the tool, then turn 2 resumes with the result ----
      messages.push({
        role: "assistant",
        content: t1.message.content,
        provider: "pi-claude-cli",
        api: "pi-claude-cli",
      });
      messages.push({
        role: "toolResult",
        toolName: "fleet_status",
        content: "3 agents working, 1 blocked on a question, codename ZEBRA-9",
      });
      const t2 = await runTurnWithMcp({ messages });
      const text2 = t2.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");

      // The model used pi's executed result.
      expect(text2).toMatch(/ZEBRA-9/);
      expect(t2.message.stopReason).toBe("stop");
    },
  );
});

describe.skipIf(!LIVE)("live guard hook + steer", () => {
  let ws: string;
  let stateDir: string;
  let outside: string;
  const piSessionId = `live-guard-${Date.now()}`;

  beforeAll(() => {
    ws = realpathSync.native(mkdtempSync(join(tmpdir(), "live-guard-")));
    stateDir = mkdtempSync(join(tmpdir(), "live-guard-state-"));
    process.env.PI_CLAUDE_CLI_STATE_DIR = stateDir;
    writeFileSync(join(ws, "inside.txt"), "the word is LANTERN\n");
    outside = join(
      realpathSync.native(tmpdir()),
      `guard-outside-${Date.now()}.txt`,
    );
    writeFileSync(outside, "the word is FORBIDDEN\n");

    // PreToolUse hook: block file tools whose path leaves the workspace —
    // the ported pidex worktree-paths guard.
    const guard = join(ws, "guard.cjs");
    writeFileSync(
      guard,
      `let raw="";process.stdin.on("data",d=>raw+=d);process.stdin.on("end",()=>{
let e={};try{e=JSON.parse(raw)}catch{}
const p=(e.tool_input||{}).file_path||(e.tool_input||{}).path||"";
if(p&&!String(p).startsWith(${JSON.stringify(ws)})){
process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:p+" is outside the session workspace. Use the workspace copy."}}));}
process.exit(0);});`,
    );
    const settings = join(ws, "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Read|Edit|Write|Bash|Grep|Glob",
              hooks: [{ type: "command", command: `node ${guard}` }],
            },
          ],
        },
      }),
    );
    process.env.PI_CLAUDE_CLI_SETTINGS = settings;
  });

  afterAll(() => {
    delete process.env.PI_CLAUDE_CLI_STATE_DIR;
    delete process.env.PI_CLAUDE_CLI_SETTINGS;
    try {
      rmSync(ws, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(outside, { force: true });
    } catch {
      /* ignore */
    }
  });

  it(
    "the hook blocks outside reads; inside reads succeed",
    { timeout: 300_000 },
    async () => {
      const messages: any[] = [
        {
          role: "user",
          content:
            `Try to read ${outside} with the Read tool; it may be refused — if so just move on silently. ` +
            "Then read inside.txt and reply with only the word it contains.",
        },
      ];
      const done = await new Promise<any>((resolve, reject) => {
        const stream = streamViaCli(model, { messages }, {
          sessionId: piSessionId,
          cwd: ws,
        } as any);
        (async () => {
          for await (const ev of stream as any) {
            if (ev.type === "done") return resolve(ev);
            if (ev.type === "error") return reject(new Error(String(ev.error)));
          }
          reject(new Error("no done"));
        })().catch(reject);
      });
      const text = done.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      expect(text).toMatch(/LANTERN/);
      expect(text).not.toMatch(/FORBIDDEN/);
    },
  );

  it(
    "an aborted turn leaves the session resumable and coherent",
    { timeout: 300_000 },
    async () => {
      const messages: any[] = [
        {
          role: "user",
          content: "Count from 1 to 300, one number per line. Do not stop.",
        },
      ];
      const controller = new AbortController();
      const stream = streamViaCli(model, { messages }, {
        sessionId: piSessionId,
        cwd: ws,
        signal: controller.signal,
      } as any);
      // Abort shortly after streaming starts.
      const done = await new Promise<any>((resolve) => {
        let timer: any;
        (async () => {
          for await (const ev of stream as any) {
            if (!timer) timer = setTimeout(() => controller.abort(), 1500);
            if (ev.type === "done") return resolve(ev);
          }
          resolve(null);
        })().catch(() => resolve(null));
      });
      expect(done).toBeTruthy();

      // Next turn on the same session must resume and answer coherently.
      messages.push({
        role: "assistant",
        content: done.message.content,
        provider: "pi-claude-cli",
        api: "pi-claude-cli",
      });
      messages.push({
        role: "user",
        content: "Stop counting. Reply with exactly: STEERED-OK",
      });
      const t2 = await new Promise<any>((resolve, reject) => {
        const s2 = streamViaCli(model, { messages }, {
          sessionId: piSessionId,
          cwd: ws,
        } as any);
        (async () => {
          for await (const ev of s2 as any) {
            if (ev.type === "done") return resolve(ev);
            if (ev.type === "error") return reject(new Error(String(ev.error)));
          }
          reject(new Error("no done"));
        })().catch(reject);
      });
      const text2 = t2.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      expect(text2).toContain("STEERED-OK");
    },
  );
});
