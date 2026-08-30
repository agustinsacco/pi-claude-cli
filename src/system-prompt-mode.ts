/**
 * Which system prompt the Claude CLI subprocess runs under.
 *
 * `claude` (the default) appends pi's prompt to Claude Code's own via
 * `--append-system-prompt-file`. Everything the CLI normally knows about its
 * built-in tools stays in place, and pi's instructions ride on top.
 *
 * `pi` replaces Claude Code's prompt outright via `--system-prompt-file`,
 * leaving only pi's — the point of a minimal harness being that it does not
 * inherit another agent's preamble.
 *
 * The `-file` suffix is not optional: the unsuffixed flags take a literal
 * string, and passing them a path (as this provider did until 2026-08-29)
 * makes the path itself the prompt, silently. See process-manager.ts.
 *
 * Sizing, measured rather than assumed: in a real session the CLI's fixed
 * cached prefix sat at 17,475 tokens. That is Claude Code's system prompt
 * *plus* the tool schemas, and the schemas (~4.3k, per pi's own breakdown)
 * stay either way — only the prompt is replaceable. Pi's prompt after the
 * tool-section rewrite is ~674 tokens, so the realistic saving is roughly
 * 12k tokens of context per call, not the full difference. It is a
 * context-window win rather than a cost win: that prefix is cached and bills
 * at 0.1x, so it was never a meaningful part of a runaway bill.
 *
 * The trade is real, which is why this is a choice and not a default flip:
 * Claude Code's prompt carries operating guidance for its own tools, so
 * dropping it means the model works from pi's instructions plus the tool
 * schemas alone. `rewritePiToolSections` compensates by restating pi's tool
 * documentation in Claude Code's names, but a model may still behave
 * differently. Default stays `claude`.
 */
export type SystemPromptMode = "claude" | "pi";

export const DEFAULT_SYSTEM_PROMPT_MODE: SystemPromptMode = "claude";

/**
 * Resolve the mode from the environment.
 *
 * Unset or unrecognised values fall back to the default rather than throwing:
 * a typo in a launcher's env should not stop a session from starting.
 */
export function resolveSystemPromptMode(
  env: NodeJS.ProcessEnv = process.env,
): SystemPromptMode {
  const raw = (env.PI_CLAUDE_CLI_SYSTEM_PROMPT ?? "").trim().toLowerCase();
  if (raw === "pi" || raw === "minimal") return "pi";
  if (raw === "claude" || raw === "append") return "claude";
  return DEFAULT_SYSTEM_PROMPT_MODE;
}
