/**
 * The private per-process directory every runtime artifact lives in.
 *
 * The handoff socket, the tool-schema file, each session's `--mcp-config` and
 * each spawn's system-prompt file all used to be written straight into
 * `os.tmpdir()` under names derived from the pid — `pi-claude-handoff-4213.sock`,
 * `pi-claude-mcp-config-4213-<session>.json` — with whatever the umask allowed.
 * On a typical `umask 022` Linux box that is a `0755` socket and `0644` files in
 * a world-readable `/tmp`, so any other local user could enumerate the paths,
 * read the CLI session ids out of the config, and connect to the broker.
 * (macOS was already safe by accident: `TMPDIR` there is a per-user `0700`
 * directory. Linux is the exposed platform, and it is the one CI runs on.)
 *
 * `mkdtempSync` gives us both halves of the fix at once: the name carries six
 * random characters, so it cannot be derived from the pid, and the directory is
 * created `0700`, so another user cannot even traverse into it. Files inside are
 * still written `0600` — defence in depth, and it keeps the guarantee if the
 * directory is ever made shareable on purpose.
 *
 * Created lazily: a pi session that never spawns the CLI leaves nothing behind.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Owner-only permissions for every file staged inside the runtime directory. */
export const RUNTIME_FILE_MODE = 0o600;

let dir: string | undefined;

/** The private directory for this process, created on first use (mode 0700). */
export function runtimeDir(): string {
  if (!dir) dir = mkdtempSync(join(tmpdir(), "pi-claude-"));
  return dir;
}

/** Path to `name` inside the private directory. */
export function runtimeFile(name: string): string {
  return join(runtimeDir(), name);
}

/**
 * Remove the directory and everything in it. Registered on `process.on("exit")`,
 * so it must stay synchronous. A SIGKILLed process still leaks the directory —
 * but it leaks a `0700` directory no other user can open.
 */
export function cleanupRuntimeDir(): void {
  if (!dir) return;
  const path = dir;
  dir = undefined;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* already gone, or not ours to remove */
  }
}

/** Test seam: forget the current directory without removing it. */
export function resetRuntimeDirForTests(): void {
  dir = undefined;
}
