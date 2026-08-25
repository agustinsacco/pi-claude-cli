/**
 * Process manager for spawning and managing Claude CLI subprocesses.
 *
 * Handles subprocess lifecycle: spawn with correct CLI flags, write NDJSON
 * messages to stdin, force-kill after result (CLI hangs bug), and stderr capture.
 * Also provides startup validation for CLI presence and authentication.
 */

import spawn from "cross-spawn";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import {
  DEFAULT_SYSTEM_PROMPT_MODE,
  type SystemPromptMode,
} from "./system-prompt-mode.js";

/**
 * Spawn a Claude CLI subprocess with all required flags for stream-json communication.
 *
 * @param modelId - The model ID to pass via --model flag
 * @param systemPrompt - Optional system prompt. In `claude` mode it is appended
 *   to Claude Code's own via --append-system-prompt; in `pi` mode it replaces
 *   it via --system-prompt. See src/system-prompt-mode.ts.
 * @param options - Optional cwd, AbortSignal, effort level and prompt mode
 * @returns The spawned ChildProcess with piped stdin/stdout/stderr
 */
/** Truthy PI_CLAUDE_CLI_HERMETIC opts in to hermetic mode (see README). */
function isHermetic(): boolean {
  const value = (process.env.PI_CLAUDE_CLI_HERMETIC ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function spawnClaude(
  modelId: string,
  systemPrompt?: string,
  options?: {
    cwd?: string;
    signal?: AbortSignal;
    effort?: string;
    mcpConfigPath?: string;
    systemPromptMode?: SystemPromptMode;
  },
): ChildProcess {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    modelId,
    "--permission-prompt-tool",
    "stdio",
  ];

  // Hermetic mode: keep the user's Claude Code environment out of pi turns.
  // --strict-mcp-config loads ONLY the servers from --mcp-config (our
  // schema-only custom-tools server survives; personal/project MCP servers
  // do not), and an empty --setting-sources skips user/project/local
  // settings — hooks, CLAUDE.md auto-memory, permission allowlists.
  // Both flags verified accepted on claude 2.1.237.
  if (isHermetic()) {
    args.push("--strict-mcp-config", "--setting-sources", "");
  }

  // Deliberately no --resume and no --session-id. Every spawn is a fresh CLI
  // session replaying pi's full history; see "Why we never resume" in
  // docs/ARCHITECTURE.md. Reintroducing --resume reintroduces the synthetic
  // "No response requested." splice that this provider's turns used to inherit.

  if (systemPrompt) {
    // Write system prompt to a temp file to avoid ENAMETOOLONG on Windows.
    // Both flags accept a file path or literal text.
    //
    // The filename is unique per spawn, not per process. Every spawn now
    // carries a system prompt (nothing resumes, so nothing inherits one), and
    // two streamViaCli calls can be in flight at once — index.ts registers the
    // same stream fn for nested agent loops and print mode. A shared per-PID
    // path let one call overwrite another's prompt, or unlink it before the
    // child had read it, in which case the CLI silently treats the *path* as
    // the literal system prompt.
    const tmpFile = systemPromptFilePath();
    writeFileSync(tmpFile, systemPrompt, "utf-8");
    spawnedPromptFiles.add(tmpFile);
    // `pi` mode replaces Claude Code's prompt outright; `claude` mode layers
    // pi's on top of it. See src/system-prompt-mode.ts for the trade-off.
    const mode = options?.systemPromptMode ?? DEFAULT_SYSTEM_PROMPT_MODE;
    args.push(
      mode === "pi" ? "--system-prompt" : "--append-system-prompt",
      tmpFile,
    );
    lastSystemPromptFile = tmpFile;
  }

  if (options?.effort) {
    args.push("--effort", options.effort);
  }

  if (options?.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath);
  }

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options?.cwd ?? process.cwd(),
  });

  // Carry the prompt file on the process so the caller cleans up exactly the
  // one it created, rather than whichever was written most recently.
  if (lastSystemPromptFile) {
    (proc as ChildProcessWithPromptFile).systemPromptFile =
      lastSystemPromptFile;
  }

  return proc as ChildProcess;
}

/** A spawned CLI process, plus the temp prompt file written for it (if any). */
export type ChildProcessWithPromptFile = ChildProcess & {
  systemPromptFile?: string;
};

/** Monotonic suffix so two spawns in the same millisecond still differ. */
let systemPromptFileSeq = 0;
/** Every prompt file this process has written and not yet removed. */
const spawnedPromptFiles = new Set<string>();
/** The most recent one, for the no-argument cleanup form. */
let lastSystemPromptFile: string | undefined;

function systemPromptFilePath(): string {
  systemPromptFileSeq += 1;
  return join(
    tmpdir(),
    `pi-claude-cli-sysprompt-${process.pid}-${systemPromptFileSeq}.txt`,
  );
}

/**
 * Remove a temp system prompt file written by spawnClaude.
 *
 * Pass the path a spawn reported to remove exactly that one. With no argument
 * it removes the most recently written file, which is what a single-threaded
 * caller wants; it must not remove *all* of them, or a concurrent spawn loses
 * the prompt its child has not read yet.
 *
 * Safe to call repeatedly, and when the file is already gone.
 */
export function cleanupSystemPromptFile(path?: string): void {
  const target = path ?? lastSystemPromptFile;
  if (!target) return;
  try {
    unlinkSync(target);
  } catch {
    // Already removed, or still held open by a child on Windows — ignore.
  }
  spawnedPromptFiles.delete(target);
  if (target === lastSystemPromptFile) lastSystemPromptFile = undefined;
}

/** Remove any prompt files still on disk. Used on process teardown. */
export function cleanupAllSystemPromptFiles(): void {
  for (const file of [...spawnedPromptFiles]) {
    cleanupSystemPromptFile(file);
  }
}

/**
 * Write a user message to the subprocess stdin as NDJSON.
 * Does NOT call stdin.end() -- stdin stays open for control_response in Phase 2.
 *
 * Accepts both string (text-only prompt) and array (ContentBlock[] with images)
 * content. JSON.stringify handles both natively. The stream-json protocol
 * supports either format in the content field.
 *
 * @param proc - The Claude subprocess
 * @param prompt - The prompt text or ContentBlock[] to send
 */
export function writeUserMessage(
  proc: ChildProcess,
  prompt: string | any[],
): void {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: prompt,
    },
  };
  proc.stdin!.write(JSON.stringify(message) + "\n");
}

/**
 * Force-kill a subprocess immediately via SIGKILL.
 * No-ops if the process is already dead (killed or exited).
 * Cross-platform safe: Node.js treats SIGKILL as forceful termination on Windows.
 *
 * @param proc - The subprocess to force-kill
 */
export function forceKillProcess(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return;
  proc.kill("SIGKILL");
}

/** Registry of active subprocesses for cleanup on teardown. */
const activeProcesses = new Set<ChildProcess>();

/**
 * Register a subprocess in the global process registry.
 * The process is automatically removed from the registry when it exits.
 *
 * @param proc - The subprocess to track
 */
export function registerProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
  proc.on("exit", () => activeProcesses.delete(proc));
}

/**
 * Force-kill all registered subprocesses and clear the registry.
 * Safe to call multiple times -- no-ops on already-dead processes.
 */
export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    forceKillProcess(proc);
  }
  activeProcesses.clear();
}

/**
 * Force-kill the subprocess after a 500ms grace period.
 * The Claude CLI hangs after emitting the result message (known bug).
 * Brief grace period allows final stdout flushing before force-kill.
 *
 * @param proc - The Claude subprocess to clean up
 */
export function cleanupProcess(proc: ChildProcess): void {
  setTimeout(() => {
    forceKillProcess(proc);
  }, 500);
}

/**
 * Attach a data listener to stderr and accumulate output into a buffer.
 *
 * @param proc - The Claude subprocess
 * @returns A function that returns the accumulated stderr string
 */
export function captureStderr(proc: ChildProcess): () => string {
  let buffer = "";
  proc.stderr!.on("data", (data: Buffer) => {
    buffer += data.toString();
  });
  return () => buffer;
}

/**
 * Validate that the Claude CLI is installed and on PATH.
 * Throws with install instructions if not found.
 */
export function validateCliPresence(): void {
  try {
    execSync("claude --version", { stdio: "pipe", timeout: 5000 });
  } catch {
    throw new Error(
      "Claude Code CLI not found. Install it: npm install -g @anthropic-ai/claude-code\n" +
        "Then authenticate by running `claude` and using `/login`.",
    );
  }
}

/**
 * Validate that the Claude CLI is authenticated.
 * Returns false and warns if not authenticated.
 *
 * Claude Code 2.x emits machine-readable JSON on `auth status` when stdout
 * is not a TTY, e.g. `{ "loggedIn": true, "authMethod": "claude.ai", ... }`.
 * We parse it and trust `loggedIn` rather than relying solely on the exit
 * code, because some transient warnings (e.g. token-refresh notices on
 * stderr) can produce a non-zero exit even when the user is signed in.
 *
 * Older CLIs that don't emit JSON fall back to exit-code semantics.
 *
 * @returns true if authenticated, false otherwise
 */
export function validateCliAuth(): boolean {
  let stdout: string | Buffer = "";
  let exitCode: number | null = null;
  try {
    stdout = execSync("claude auth status", {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      encoding: "utf8",
    });
    exitCode = 0;
  } catch (err) {
    const e = err as { status?: number | null; stdout?: Buffer | string };
    exitCode = typeof e.status === "number" ? e.status : null;
    stdout = e.stdout ?? "";
  }

  const trimmed = (
    typeof stdout === "string" ? stdout : stdout.toString()
  ).trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { loggedIn?: boolean };
      if (parsed.loggedIn === true) return true;
      warnUnauth();
      return false;
    } catch {
      // fall through to exit-code semantics
    }
  }

  if (exitCode === 0) return true;
  warnUnauth();
  return false;
}

function warnUnauth(): void {
  console.warn(
    "[pi-claude-cli] Claude CLI is not authenticated. " +
      "Run `claude` and use `/login` to authenticate.",
  );
}
