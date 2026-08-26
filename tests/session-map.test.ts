import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getCliSession,
  setCliSession,
  clearCliSession,
} from "../src/session-map";

describe("session-map sidecar", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pcc-map-"));
    process.env.PI_CLAUDE_CLI_STATE_DIR = dir;
  });

  afterEach(() => {
    delete process.env.PI_CLAUDE_CLI_STATE_DIR;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("round-trips a mapping", () => {
    setCliSession("pi-1", "cli-1");
    expect(getCliSession("pi-1")).toBe("cli-1");
  });

  it("returns undefined for unknown pi sessions", () => {
    expect(getCliSession("nope")).toBeUndefined();
  });

  it("clears a mapping", () => {
    setCliSession("pi-1", "cli-1");
    clearCliSession("pi-1");
    expect(getCliSession("pi-1")).toBeUndefined();
  });

  it("clearing an absent mapping is a no-op", () => {
    expect(() => clearCliSession("never-set")).not.toThrow();
  });

  it("keeps unrelated mappings when one is updated", () => {
    setCliSession("pi-1", "cli-1");
    setCliSession("pi-2", "cli-2");
    setCliSession("pi-1", "cli-1b");
    expect(getCliSession("pi-1")).toBe("cli-1b");
    expect(getCliSession("pi-2")).toBe("cli-2");
  });

  it("treats a corrupt sidecar as empty rather than throwing", () => {
    writeFileSync(join(dir, "session-map.json"), "{not json");
    expect(getCliSession("pi-1")).toBeUndefined();
    // And a write recovers the file.
    setCliSession("pi-1", "cli-1");
    expect(getCliSession("pi-1")).toBe("cli-1");
  });

  it("treats a non-object sidecar as empty", () => {
    writeFileSync(join(dir, "session-map.json"), JSON.stringify(["array"]));
    expect(getCliSession("pi-1")).toBeUndefined();
  });

  it("creates the state directory on first write", () => {
    process.env.PI_CLAUDE_CLI_STATE_DIR = join(dir, "nested", "deeper");
    setCliSession("pi-1", "cli-1");
    expect(getCliSession("pi-1")).toBe("cli-1");
    const raw = readFileSync(
      join(dir, "nested", "deeper", "session-map.json"),
      "utf-8",
    );
    expect(JSON.parse(raw)["pi-1"]).toBe("cli-1");
  });
});
