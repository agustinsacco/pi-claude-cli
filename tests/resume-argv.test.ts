/**
 * Resume argv guard — spawns the real Claude CLI stub, spends no tokens.
 *
 * The bug: the CLI does not keep `--system-prompt` across `--resume`. A
 * provider that sends it only on the session-creating spawn silently runs
 * every later turn under Claude Code's DEFAULT prompt — pi's instructions
 * gone — and pays a full cache rebuild for the prefix swap. Measured
 * 2026-08-29 against the real CLI: 9,761 cache-write tokens on turn 2 with
 * the flag dropped, 112 with it re-sent.
 *
 * Unlike tests/provider.test.ts this file does NOT mock cross-spawn, so it
 * checks the argv that a real `claude` process would receive, and reads the
 * temp files the flags actually point at. Byte-identity is the assertion that
 * matters: a rebuilt-but-drifted prompt costs the same as no prompt at all.
 *
 * POSIX only. The shim is an extensionless file with a shebang, which Windows
 * will not execute (PATHEXT), the same reason scripts/e2e-stub.sh is bash-only.
 * The argv assertions in tests/provider.test.ts run everywhere and cover the
 * same behaviour against a mocked spawn; this file adds the real-process leg.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  chmodSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { streamViaCli } from "../src/provider.js";

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

describe.skipIf(process.platform === "win32")(
  "resume argv (real spawn, stub CLI)",
  () => {
    let stubDir: string;
    let captureFile: string;
    let stateDir: string;
    let ws: string;
    let originalPath: string | undefined;
    const piSessionId = `argv-${Date.now()}`;

    beforeAll(() => {
      stubDir = mkdtempSync(join(tmpdir(), "argv-stub-"));
      stateDir = mkdtempSync(join(tmpdir(), "argv-state-"));
      ws = realpathSync.native(mkdtempSync(join(tmpdir(), "argv-ws-")));
      captureFile = join(stateDir, "argv.jsonl");

      // Wrap the stub so every spawn's argv — and the system prompt file it
      // points at — is recorded before it responds. The file is captured here
      // rather than read later because the provider deletes it at turn end.
      copyFileSync(
        join(__dirname, "e2e", "claude-stub.cjs"),
        join(stubDir, "claude-stub.cjs"),
      );
      writeFileSync(
        join(stubDir, "claude"),
        `#!/usr/bin/env node
` +
          `const fs = require("node:fs");
` +
          `const argv = process.argv.slice(2);
` +
          `let sysprompt = null;
` +
          `for (const flag of ["--system-prompt-file", "--append-system-prompt-file"]) {
` +
          `  const i = argv.indexOf(flag);
` +
          `  if (i !== -1) { try { sysprompt = fs.readFileSync(argv[i + 1], "utf-8"); } catch {} }
` +
          `}
` +
          `fs.appendFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ argv, sysprompt }) + "\\n");
` +
          `require(${JSON.stringify(join(stubDir, "claude-stub.cjs"))});
`,
      );
      chmodSync(join(stubDir, "claude"), 0o755);

      originalPath = process.env.PATH;
      process.env.PATH = `${stubDir}:${process.env.PATH}`;
      process.env.PI_CLAUDE_CLI_STATE_DIR = stateDir;
      // Pin the mode so the assertions name one flag, not whichever the ambient
      // environment happens to select.
      process.env.PI_CLAUDE_CLI_SYSTEM_PROMPT = "claude";
    });

    afterAll(() => {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      delete process.env.PI_CLAUDE_CLI_STATE_DIR;
      delete process.env.PI_CLAUDE_CLI_SYSTEM_PROMPT;
      for (const d of [stubDir, stateDir, ws]) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    const turn = (messages: any[]): Promise<any> =>
      new Promise((resolve, reject) => {
        const stream = streamViaCli(
          model,
          { messages, systemPrompt: "PI SYSTEM PROMPT\n\nSecond block." },
          { sessionId: piSessionId, cwd: ws } as any,
        );
        (async () => {
          for await (const ev of stream as any) {
            if (ev.type === "done") return resolve(ev);
            if (ev.type === "error") return reject(new Error(String(ev.error)));
          }
          reject(new Error("stream ended without done"));
        })().catch(reject);
      });

    it(
      "re-sends the byte-identical system prompt on the resumed spawn",
      { timeout: 60_000 },
      async () => {
        const t1 = await turn([{ role: "user", content: "first" }]);
        await turn([
          { role: "user", content: "first" },
          {
            role: "assistant",
            content: t1.message.content,
            provider: "pi-claude-cli",
            api: "pi-claude-cli",
          },
          // A toolResult in history is what makes a REBUILT prompt drift:
          // buildSystemPrompt appends an extra paragraph once one exists. The
          // stored replay has to be immune to that.
          { role: "toolResult", content: "r" },
          { role: "user", content: "second" },
        ]);

        const spawns: { argv: string[]; sysprompt: string | null }[] =
          readFileSync(captureFile, "utf-8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l))
            // Drop the --version / `auth status` probes.
            .filter((s: { argv: string[] }) => s.argv.includes("-p"));

        expect(spawns.length).toBeGreaterThanOrEqual(2);
        const [first, second] = spawns;

        // Turn 2 resumed rather than reimported.
        expect(second.argv).toContain("--resume");

        // Both spawns carry the prompt. Dropping it on resume is the bug.
        expect(first.argv).toContain("--append-system-prompt-file");
        expect(second.argv).toContain("--append-system-prompt-file");

        // Byte-identical, or the prefix cache misses just as badly as if the
        // prompt had been omitted.
        expect(second.sysprompt).toBe(first.sysprompt);
        expect(second.sysprompt).toContain("PI SYSTEM PROMPT");

        // Staging path is keyed by CLI session, so a concurrent turn of a
        // DIFFERENT session cannot clobber this one. Same-session turns are
        // serialized by pi and legitimately share the path.
        const cliId = second.argv[second.argv.indexOf("--resume") + 1];
        const pathOf = (a: string[]) =>
          a[a.indexOf("--append-system-prompt-file") + 1];
        expect(pathOf(second.argv)).toContain(cliId);
        expect(pathOf(first.argv)).toContain(cliId);
      },
    );
  },
);
