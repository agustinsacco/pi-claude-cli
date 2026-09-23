/**
 * Boolean env opt-ins shared by the spawn path and the session sidecar.
 *
 * Lives on its own so src/session-map.ts can read a flag without importing
 * the process manager (and cross-spawn with it).
 */

/** Truthy env opt-in: "1", "true" or "yes", case-insensitive. */
export function envFlag(name: string): boolean {
  const value = (process.env[name] ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Truthy PI_CLAUDE_CLI_EPHEMERAL marks every turn as a one-shot with no next
 * turn to resume (see README). Hosts set it for `pi -p --no-session` calls —
 * session auto-naming, health checks — where pi keeps nothing, so nothing the
 * provider would write for a later `--resume` can ever be read back:
 *
 * - the CLI transcript under ~/.claude/projects (spawned with
 *   `--no-session-persistence` instead),
 * - the pi → CLI pairing in session-map.json,
 * - the stored system prompt under sysprompt/<cliId>.txt.
 *
 * Measured on one install before this existed: 238 orphaned transcripts
 * (~60 KB each), 727 of 794 map entries and 863 of 910 stored prompts dead.
 */
export function isEphemeral(): boolean {
  return envFlag("PI_CLAUDE_CLI_EPHEMERAL");
}
