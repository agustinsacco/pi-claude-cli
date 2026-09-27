import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("cross-spawn", () => ({ default: vi.fn(() => ({})) }));
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => Buffer.from("2.1.263 (Claude Code)")),
}));
import spawn from "cross-spawn";
import { spawnClaude, cleanupSystemPromptFile } from "../src/process-manager";
import { handleControlRequest } from "../src/control-handler";

afterEach(() => {
  cleanupSystemPromptFile();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("default pi-owned launch", () => {
  it("replaces the prompt, disables native tools and persistence, preserves explicit guards and auth", () => {
    delete process.env.PI_CLAUDE_CLI_CONTEXT;
    vi.stubEnv("PI_CLAUDE_CLI_SETTINGS", "/host/guards.json");
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/account/selected");
    vi.stubEnv("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "0");
    spawnClaude("claude-haiku-4-5", "PI-CONTEXT", {
      mcpConfigPath: "/pi/bridge.json",
    });
    const [, args, options] = vi.mocked(spawn).mock.calls[0];
    const argv = args as string[];
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv).toContain("--disable-slash-commands");
    expect(argv).toContain("--no-chrome");
    expect(argv).toContain("--no-session-persistence");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe("/pi/bridge.json");
    expect(argv[argv.indexOf("--settings") + 1]).toBe("/host/guards.json");
    expect(
      readFileSync(argv[argv.indexOf("--system-prompt-file") + 1], "utf8"),
    ).toBe("PI-CONTEXT");
    for (const forbidden of [
      "--bare",
      "--safe-mode",
      "--append-system-prompt-file",
      "--autocompact",
      "--dangerously-skip-permissions",
    ])
      expect(argv).not.toContain(forbidden);
    expect(options?.env).toMatchObject({
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/account/selected",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_COMPACT: "1",
      ENABLE_TOOL_SEARCH: "false",
    });
    expect(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("0");
  });

  it("passes --no-session-persistence once, with or without PI_CLAUDE_CLI_EPHEMERAL", () => {
    // A host's one-shots (session naming) set the ephemeral flag on top of
    // the default; the two reasons for the flag must not stack it.
    delete process.env.PI_CLAUDE_CLI_CONTEXT;
    for (const ephemeral of ["", "1"]) {
      vi.stubEnv("PI_CLAUDE_CLI_EPHEMERAL", ephemeral);
      spawnClaude("claude-haiku-4-5", "PI-CONTEXT", { newSessionId: "once" });
      const argv = vi.mocked(spawn).mock.calls.at(-1)![1] as string[];
      expect(
        argv.filter((arg) => arg === "--no-session-persistence"),
        `PI_CLAUDE_CLI_EPHEMERAL=${ephemeral}`,
      ).toHaveLength(1);
      expect(argv[argv.indexOf("--session-id") + 1]).toBe("once");
    }
    cleanupSystemPromptFile("once");
  });

  it("never resumes an old CLI transcript or falls back to its prompt", () => {
    delete process.env.PI_CLAUDE_CLI_CONTEXT;
    spawnClaude("claude-haiku-4-5", undefined, { resumeSessionId: "existing" });
    const argv = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(argv).not.toContain("--resume");
    expect(argv).toContain("--system-prompt-file");
    cleanupSystemPromptFile("existing");
  });

  it("refuses non-pi execution even if a native permission request arrives", () => {
    delete process.env.PI_CLAUDE_CLI_CONTEXT;
    const stdin = { write: vi.fn() };
    const request = {
      request_id: "x",
      request: { tool_name: "Bash", input: {} },
    } as any;
    expect(
      handleControlRequest(request, stdin as any, { allowHandoff: true }),
    ).toBe(false);
    request.request.tool_name = "mcp__custom-tools__bash";
    expect(
      handleControlRequest(request, stdin as any, { allowHandoff: true }),
    ).toBe(true);
  });
});
