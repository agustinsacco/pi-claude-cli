/**
 * pi session → Claude CLI session mapping.
 *
 * Observer mode keeps ONE CLI session per pi session and resumes it across
 * turns and pi restarts. pi stays the system of record: this sidecar is
 * derived state, and losing it only costs one full-history reimport.
 *
 * A flat JSON file rather than per-session files: entries are tiny, writes
 * are rare (one per created CLI session), and a single pi process owns a
 * given pi session at a time.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function stateDir(): string {
  return (
    process.env.PI_CLAUDE_CLI_STATE_DIR ||
    join(homedir(), ".pi", "agent", "pi-claude-cli")
  );
}

function mapPath(): string {
  return join(stateDir(), "session-map.json");
}

function readMap(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(mapPath(), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Missing or corrupt — both mean "no mappings", which is always safe.
  }
  return {};
}

function writeMap(map: Record<string, string>): void {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(mapPath(), JSON.stringify(map, null, 2), "utf-8");
  } catch {
    // Best effort: an unwritable sidecar degrades to reimport-per-restart.
  }
}

/** CLI session id for a pi session, if one was created and recorded. */
export function getCliSession(piSessionId: string): string | undefined {
  return readMap()[piSessionId];
}

export function setCliSession(piSessionId: string, cliSessionId: string): void {
  const map = readMap();
  map[piSessionId] = cliSessionId;
  writeMap(map);
}

/** Forget a mapping so the next turn reimports from pi history. */
export function clearCliSession(piSessionId: string): void {
  const map = readMap();
  if (piSessionId in map) {
    delete map[piSessionId];
    writeMap(map);
  }
}

// ---------------------------------------------------------------------------
// Per-CLI-session system prompt.
//
// The CLI does NOT persist --system-prompt across --resume: a resumed session
// runs under Claude Code's DEFAULT prompt unless the flag is passed again.
// That is both a correctness bug (pi's instructions vanish from turn 2 on) and
// the single largest token cost in a pi session, because swapping the prompt
// invalidates the cached prefix and re-bills the whole transcript as cache
// WRITE. Verified 2026-08-29 with a shimmed `claude`: re-passing the same
// prompt on resume cost 112 tokens where dropping it cost 9,761.
//
// Re-passing is only cheap when the bytes are IDENTICAL, and rebuilding is not
// byte-stable — buildSystemPrompt() appends a tool-results paragraph the
// moment history contains a toolResult, and pi may restyle its own prompt
// between turns. So the prompt the session was CREATED with is stored here and
// replayed verbatim for the life of that CLI session.
//
// One file per session rather than a field in session-map.json: prompts run to
// tens of kilobytes, and the map is read on every spawn.
// ---------------------------------------------------------------------------

function systemPromptPath(cliSessionId: string): string {
  return join(stateDir(), "sysprompt", `${cliSessionId}.txt`);
}

/**
 * The system prompt a CLI session was created with, if it was recorded.
 *
 * Undefined for sessions created before this was stored, which correctly falls
 * back to rebuilding: less cache-stable than a verbatim replay, still far
 * better than sending no prompt at all.
 */
export function getSystemPrompt(cliSessionId: string): string | undefined {
  try {
    return readFileSync(systemPromptPath(cliSessionId), "utf-8");
  } catch {
    return undefined;
  }
}

export function setSystemPrompt(cliSessionId: string, prompt: string): void {
  try {
    mkdirSync(join(stateDir(), "sysprompt"), { recursive: true });
    writeFileSync(systemPromptPath(cliSessionId), prompt, "utf-8");
  } catch {
    // Best effort: an unwritable sidecar degrades to rebuilding the prompt.
  }
}

/** Drop a stored prompt. Paired with clearCliSession on a resume miss. */
export function clearSystemPrompt(cliSessionId: string): void {
  try {
    rmSync(systemPromptPath(cliSessionId), { force: true });
  } catch {
    // Already gone, or unwritable — both are fine.
  }
}
