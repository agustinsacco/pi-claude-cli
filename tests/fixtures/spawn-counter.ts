import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

/**
 * A `claude` on PATH that records each turn process, then runs the real one.
 *
 * pi and this test may run under a scratch HOME; the real CLI gets the
 * account's own home (from the passwd entry, not the environment), because
 * that is where its login lives. It writes no transcript either way: pi
 * context spawns it with --no-session-persistence.
 */
export function spawnCounter(dir: string) {
  const real = execSync("command -v claude", { encoding: "utf8" }).trim();
  const home = userInfo().homedir;
  const log = join(dir, "spawns.log");
  writeFileSync(log, "");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const wrapper = join(bin, "claude");
  writeFileSync(
    wrapper,
    `#!/bin/sh\ncase "$*" in *--input-format*) echo spawn >> "${log}";; esac\nHOME="${home}" exec "${real}" "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return {
    bin,
    count: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length,
  };
}
