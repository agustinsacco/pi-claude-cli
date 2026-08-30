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
 *   to Claude Code's own via --append-system-prompt-file; in `pi` mode it
 *   replaces it via --system-prompt-file. The `-file` suffix is required: the
 *   unsuffixed flags take a literal string. See src/system-prompt-mode.ts.
 * @param options - Optional cwd, AbortSignal, effort level and prompt mode
 * @returns The spawned ChildProcess with piped stdin/stdout/stderr
 */
/** Truthy PI_CLAUDE_CLI_HERMETIC opts in to hermetic mode (see README). */
function isHermetic(): boolean {
  const value = (process.env.PI_CLAUDE_CLI_HERMETIC ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Where a spawn's system prompt is staged. Scoped to the CLI session so
 * concurrent turns in one pi process cannot clobber each other.
 */
function systemPromptFilePath(sessionKey?: string): string {
  const suffix = sessionKey ? `-${sessionKey}` : "";
  return join(tmpdir(), `pi-claude-cli-sysprompt-${process.pid}${suffix}.txt`);
}

export function spawnClaude(
  modelId: string,
  systemPrompt?: string,
  options?: {
    cwd?: string;
    signal?: AbortSignal;
    effort?: string;
    mcpConfigPath?: string;
    resumeSessionId?: string;
    newSessionId?: string;
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
    // `AskUserQuestion` renders a picker in the CLI's own TUI, and `-p` has
    // no TUI. The call therefore cannot be answered by anyone: it returns
    // "The user did not answer the questions." after a full round trip, and
    // the model reads that as a person who declined and falls back to asking
    // in prose. Captured 2026-08-28 on claude-sonnet-5, which then wrote
    // "happy to discuss in plain text instead". Take the tool away so the
    // model asks in prose the first time — the host's UI shows prose, and
    // the user can answer it.
    "--disallowedTools",
    "AskUserQuestion",
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

  if (options?.resumeSessionId) {
    // Resume an existing session — CLI loads prior conversation from disk
    args.push("--resume", options.resumeSessionId);
  } else if (options?.newSessionId) {
    // First turn: create session with this ID so subsequent turns can --resume it
    args.push("--session-id", options.newSessionId);
  }

  if (systemPrompt) {
    // Write the system prompt to a temp file and pass the FILE flags.
    //
    // `--system-prompt` / `--append-system-prompt` take a literal string, NOT
    // a path: handing them a path makes the path itself the system prompt, so
    // pi's instructions never reach the model and the session silently runs on
    // Claude Code's defaults. Verified on claude 2.1.231 — with a path the
    // model denied having the codename its prompt assigned; with
    // `--system-prompt-file` it answered correctly. The file variants also keep
    // the prompt off the command line, which is what avoids ENAMETOOLONG on
    // Windows.
    //
    // Keyed by CLI session, not just pid: the prompt goes on every spawn
    // (see provider.ts), and pi can run two turns of one process at once —
    // its own sub-agents do. A shared per-pid path would let one turn
    // overwrite the prompt another turn is about to read.
    const tmpFile = systemPromptFilePath(
      options?.resumeSessionId ?? options?.newSessionId,
    );
    writeFileSync(tmpFile, systemPrompt, "utf-8");
    // `pi` mode replaces Claude Code's prompt outright; `claude` mode layers
    // pi's on top of it. See src/system-prompt-mode.ts for the trade-off.
    const mode = options?.systemPromptMode ?? DEFAULT_SYSTEM_PROMPT_MODE;
    args.push(
      mode === "pi" ? "--system-prompt-file" : "--append-system-prompt-file",
      tmpFile,
    );
  }

  // Host-supplied Claude Code settings (hooks, permissions). This is how a
  // host injects PreToolUse guards — e.g. pidex's worktree-paths guard —
  // without pi intercepting the CLI's native tool execution.
  const settingsPath = process.env.PI_CLAUDE_CLI_SETTINGS;
  if (settingsPath) {
    args.push("--settings", settingsPath);
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

  return proc as ChildProcess;
}

/**
 * Clean up the temp system prompt file created by spawnClaude.
 * Safe to call multiple times or when no file exists.
 *
 * Pass the same CLI session key the spawn used; omitting it cleans the
 * unscoped path, which is all a spawn without a session id creates.
 */
export function cleanupSystemPromptFile(sessionKey?: string): void {
  try {
    unlinkSync(systemPromptFilePath(sessionKey));
  } catch {
    // File doesn't exist or already deleted — ignore
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
 * Ask the CLI to end the current turn cleanly — the same interrupt a human
 * Esc produces. Unlike SIGKILL this lets the CLI persist the turn, so the
 * session stays resumable without transcript corruption. The turn then ends
 * with a `result` of subtype `error_during_execution`, which callers must
 * treat as expected.
 */
export function sendInterrupt(proc: ChildProcess): void {
  // `exitCode != null` (loose): undefined means "has not exited" on mocks and
  // some stream wrappers, and must count as alive.
  if (proc.killed || proc.exitCode != null || !proc.stdin) return;
  const request = {
    type: "control_request",
    request_id: `int-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    request: { subtype: "interrupt" },
  };
  try {
    proc.stdin.write(JSON.stringify(request) + "\n");
  } catch {
    // stdin already closed — the force-kill fallback will handle it.
  }
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
