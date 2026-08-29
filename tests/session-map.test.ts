import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getCliSession,
  setCliSession,
  clearCliSession,
  getSystemPrompt,
  setSystemPrompt,
  clearSystemPrompt,
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

  describe("stored system prompt", () => {
    it("round-trips a prompt verbatim", () => {
      // Byte-exactness is the whole point: a resumed spawn re-sends these
      // bytes, and any drift re-bills the transcript as cache write.
      const prompt = "line one\n\nline two \u2014 with unicode\n";
      setSystemPrompt("cli-1", prompt);
      expect(getSystemPrompt("cli-1")).toBe(prompt);
    });

    it("returns undefined for a session recorded before prompts were stored", () => {
      expect(getSystemPrompt("legacy-session")).toBeUndefined();
    });

    it("keeps prompts per session", () => {
      setSystemPrompt("cli-1", "ONE");
      setSystemPrompt("cli-2", "TWO");
      expect(getSystemPrompt("cli-1")).toBe("ONE");
      expect(getSystemPrompt("cli-2")).toBe("TWO");
    });

    it("clears a prompt, and clearing an absent one is a no-op", () => {
      setSystemPrompt("cli-1", "ONE");
      clearSystemPrompt("cli-1");
      expect(getSystemPrompt("cli-1")).toBeUndefined();
      expect(() => clearSystemPrompt("never-set")).not.toThrow();
    });

    it("creates the nested directory on first write", () => {
      process.env.PI_CLAUDE_CLI_STATE_DIR = join(dir, "fresh");
      setSystemPrompt("cli-1", "ONE");
      expect(
        readFileSync(join(dir, "fresh", "sysprompt", "cli-1.txt"), "utf-8"),
      ).toBe("ONE");
    });

    it("does not throw when the state dir is unwritable", () => {
      // Degrades to rebuilding the prompt, which is correct but less cacheable.
      writeFileSync(join(dir, "blocker"), "not a directory");
      process.env.PI_CLAUDE_CLI_STATE_DIR = join(dir, "blocker");
      expect(() => setSystemPrompt("cli-1", "ONE")).not.toThrow();
      expect(getSystemPrompt("cli-1")).toBeUndefined();
    });
  });
});
