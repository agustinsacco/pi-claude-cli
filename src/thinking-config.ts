/**
 * Thinking effort configuration for mapping pi's ThinkingLevel to Claude CLI --effort flags.
 *
 * Maps pi's reasoning levels (minimal/low/medium/high/xhigh/max) to the CLI's effort
 * levels (low/medium/high/xhigh/max). Every model passes through 1:1 apart from
 * `minimal`, which the CLI has no rung for and which floors at `low`.
 *
 * IMPORTANT: The CLI does NOT support --thinking-budget. Only --effort is supported.
 */

import type { ThinkingLevel, ThinkingBudgets } from "@earendil-works/pi-ai";

/** CLI effort levels accepted by the --effort flag */
export type CliEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * pi ThinkingLevel -> CLI effort, 1:1 for every rung the CLI has.
 *
 * The CLI accepts the full ladder (low/medium/high/xhigh/max) on every current
 * model — verified with claude-fable-5 and claude-sonnet-5, and on 2026-08-27
 * with claude-opus-5, where `--effort high`, `xhigh` and `max` were each
 * accepted and recorded distinctly in the session transcript's `effort` field.
 *
 * Opus used to be shifted up a rung here (medium→high, high→max) to compensate
 * for a cap that no longer exists. That made `high` unrequestable on opus and
 * was not a private detail: Claude Code skills size their own sub-agent fan-out
 * from this flag, so a host asking for `high` silently got the widest tier the
 * skill offered. See https://github.com/agustinsacco/pi-claude-cli/issues/22.
 *
 * `minimal` has no CLI rung and floors at `low`. That is a floor, not a shift:
 * it maps down, and no level maps above what the host asked for.
 */
const EFFORT_MAP: Record<ThinkingLevel, CliEffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * Map pi's ThinkingLevel to a CLI effort string.
 *
 * When reasoning is undefined, returns undefined so the --effort flag is omitted
 * entirely, letting the CLI use its default behavior. When thinkingBudgets are
 * provided, a console.warn is logged because the CLI only supports effort levels,
 * not token budgets.
 *
 * @param reasoning - Pi's thinking level (undefined = omit flag)
 * @param _modelId - Unused; kept so callers need not change. Every model maps alike.
 * @param thinkingBudgets - Custom budgets (logged as unsupported, not applied)
 * @returns CLI effort level string, or undefined if flag should be omitted
 */
export function mapThinkingEffort(
  reasoning?: ThinkingLevel,
  _modelId?: string,
  thinkingBudgets?: ThinkingBudgets,
): CliEffortLevel | undefined {
  if (reasoning === undefined) {
    return undefined; // omit --effort flag entirely
  }

  if (thinkingBudgets && Object.keys(thinkingBudgets).length > 0) {
    console.warn(
      "[pi-claude-cli] Custom thinkingBudgets are not supported with CLI subprocess. " +
        "The CLI uses --effort levels instead of token budgets. Budgets will be ignored.",
    );
  }

  return EFFORT_MAP[reasoning];
}
