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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
