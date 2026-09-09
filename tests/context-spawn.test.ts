import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("cross-spawn", () => ({ default: vi.fn(() => ({})) }));
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("2.1.263 (Claude Code)")),
}));
import spawn from "cross-spawn";
import { spawnClaude, cleanupSystemPromptFile } from "../src/process-manager";

afterEach(() => {
  cleanupSystemPromptFile();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("pi context launch profile", () => {
  it("isolates discovery while retaining native tools, the default prompt, host guards and auth environment", () => {
    vi.stubEnv("PI_CLAUDE_CLI_CONTEXT", "pi");
    vi.stubEnv("PI_CLAUDE_CLI_SETTINGS", "/host/guards.json");
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/account/selected");
    vi.stubEnv("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "0");
    vi.stubEnv("ENABLE_CLAUDEAI_MCP_SERVERS", "true");
    spawnClaude("claude-haiku-4-5", "PI-CONTEXT", {
      mcpConfigPath: "/pi/bridge.json",
    });
    const [, args, options] = vi.mocked(spawn).mock.calls[0];
    const argv = args as string[];
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv).toContain("--disable-slash-commands");
    expect(argv).toContain("--no-chrome");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe("/pi/bridge.json");
    expect(argv[argv.indexOf("--settings") + 1]).toBe("/host/guards.json");
    expect(
      readFileSync(
        argv[argv.indexOf("--append-system-prompt-file") + 1],
        "utf8",
      ),
    ).toBe("PI-CONTEXT");
    for (const forbidden of [
      "--bare",
      "--safe-mode",
      "--tools",
      "--system-prompt-file",
      "--dangerously-skip-permissions",
    ]) {
      expect(argv).not.toContain(forbidden);
    }
    expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe("AskUserQuestion");
    expect(options?.env).toMatchObject({
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/account/selected",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    });
    expect(options?.env).not.toHaveProperty("CLAUDE_CODE_SIMPLE");
    expect(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("0");
  });

  it("applies the same policy on resume", () => {
    vi.stubEnv("PI_CLAUDE_CLI_CONTEXT", "pi");
    spawnClaude("claude-haiku-4-5", undefined, { resumeSessionId: "existing" });
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        "--resume",
        "existing",
        "--disable-slash-commands",
        "--strict-mcp-config",
      ]),
    );
  });

  it("refuses conflicting prompt replacement before spawning", () => {
    vi.stubEnv("PI_CLAUDE_CLI_CONTEXT", "pi");
    expect(() =>
      spawnClaude("claude-haiku-4-5", "prompt", { systemPromptMode: "pi" }),
    ).toThrow("default system prompt");
    expect(spawn).not.toHaveBeenCalled();
  });
});
