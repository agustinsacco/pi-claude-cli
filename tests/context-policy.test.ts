import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alignPiContext,
  assertContextPolicy,
  assertContextCliVersion,
  isPolicyOnlyPrompt,
  PI_CONTEXT_MARKER,
  usesPiContext,
} from "../src/context-policy";
import { buildSystemPrompt } from "../src/prompt-builder";
import {
  PI_087_PROMPT,
  leadingSystemMessage,
  sectionPatch,
} from "./fixtures/pi-transcript";

const suffix = `Pi documentation (read only when asked):
- Main documentation: /home/user/.pi/docs

CUSTOM DIRECTIVES: Use edit with oldText; preserve this user-authored rule verbatim.

<project_context><project_instructions path="/repo/CLAUDE.md">PROJECT-SENTINEL .pi/config</project_instructions></project_context>

<available_skills><skill><name>audit</name><location>/home/user/.pi/skills/audit/SKILL.md</location></skill></available_skills>`;
const prompt = `You are an expert coding assistant operating inside pi, a coding agent harness.

Available tools:
- read: Read files
- edit: Make edits
- bash: Execute commands
- grep: Search content
- find: Find files
- artifact_create: Publish an artifact
- mcp: Call the pi MCP gateway
- annotate: Custom annotations with oldText and newText

In addition to the tools above, you may have access to other custom tools.

Guidelines:
- Use read to examine files
- Use grep to search files
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing separate locations use edits[]
- Each edits[].oldText is matched against the original file, not after earlier edits are applied.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use artifact_create for substantial deliverables
- Theme: honor light and dark modes
- Custom annotations may use oldText and newText

${suffix}`;

afterEach(() => vi.unstubAllEnvs());

describe("pi context with native execution", () => {
  it("requires a CLI that supports the tested isolation controls", () => {
    for (const version of ["2.1.263 (Claude Code)", "2.2.0", "3.0.0"])
      expect(() => assertContextCliVersion(version)).not.toThrow();
    for (const version of [
      "2.1.262",
      "2.0.999",
      "1.99.999",
      "unknown",
      "2.1.263-beta",
    ])
      expect(() => assertContextCliVersion(version)).toThrow(
        "Update Claude Code",
      );
  });
  it("is opt-in and rejects misspelled policies", () => {
    expect(usesPiContext({})).toBe(false);
    expect(usesPiContext({ PI_CLAUDE_CLI_CONTEXT: "legacy" })).toBe(false);
    expect(usesPiContext({ PI_CLAUDE_CLI_CONTEXT: " PI " })).toBe(true);
    expect(() => usesPiContext({ PI_CLAUDE_CLI_CONTEXT: "typo" })).toThrow(
      "must be",
    );
  });

  it("aligns the generated vocabulary without erasing artifact guidance or user context", () => {
    const out = alignPiContext(prompt);
    expect(out).toContain(
      "- Read: Read file contents using the native Read schema",
    );
    expect(out).toContain("- Edit: Replace exact text using native Edit");
    expect(out).toContain("separate calls for disjoint replacements");
    expect(out).toContain(
      "- Bash: Execute commands using the native Bash schema",
    );
    expect(out).toContain(
      "- mcp__custom-tools__artifact_create: Publish an artifact",
    );
    expect(out).toContain("- mcp__custom-tools__mcp: Call the pi MCP gateway");
    expect(out).toContain("- Use Read to examine files");
    expect(out).not.toMatch(/^- (Grep|Glob|grep|find):/m);
    expect(out).toContain(
      "- Use available native search tools (or Bash) to search files",
    );
    expect(out).toContain("only if actually advertised; otherwise use Bash");
    // Every phrasing pi 0.85.1 ships, not just the three the first cut listed:
    // "Keep edits[].oldText as small as possible" survived into live sessions.
    expect(out).not.toContain("edits[]");
    expect(out).toContain("- Use artifact_create for substantial deliverables");
    expect(out).toContain("- Theme: honor light and dark modes");
    expect(out).toContain(
      "- mcp__custom-tools__annotate: Custom annotations with oldText and newText",
    );
    expect(out).toContain("- Custom annotations may use oldText and newText");
    expect(out.endsWith(suffix)).toBe(true);
    expect(out.match(/PROJECT-SENTINEL/g)).toHaveLength(1);
    expect(out.match(/<available_skills>/g)).toHaveLength(1);
    expect(out).toContain("/home/user/.pi/skills/audit/SKILL.md");
    expect(out).not.toContain("/home/user/.claude/");
  });

  it("keeps custom and unfamiliar prompts intact with a vocabulary binding", () => {
    const custom =
      "Available tools:\n- edit: My custom rule\n\nUse .pi/docs exactly.";
    expect(alignPiContext(custom).endsWith(custom)).toBe(true);
    expect(alignPiContext(custom)).toContain("Native Edit uses file_path");
  });

  it("does not rediscover this repository's AGENTS or add history-dependent prompt text", () => {
    vi.stubEnv("PI_CLAUDE_CLI_CONTEXT", "pi");
    const first = buildSystemPrompt(
      { systemPrompt: prompt, messages: [] },
      process.cwd(),
    );
    const next = buildSystemPrompt(
      { systemPrompt: prompt, messages: [{ role: "toolResult" }] },
      process.cwd(),
    );
    expect(first).toBe(alignPiContext(prompt));
    expect(next).toBe(first);
    expect(() =>
      buildSystemPrompt(
        { systemPrompt: prompt, messages: [] },
        process.cwd(),
        "pi",
      ),
    ).toThrow("default claude");
  });

  it("requires fresh sessions across policy boundaries, but permits same-policy resumes", () => {
    expect(() => assertContextPolicy("legacy prompt", false)).not.toThrow();
    expect(() => assertContextPolicy(undefined, false)).not.toThrow();
    expect(() =>
      assertContextPolicy(`${PI_CONTEXT_MARKER}\npi prompt`, true),
    ).not.toThrow();
    expect(() => assertContextPolicy("legacy prompt", true)).toThrow(
      "fresh pi session",
    );
    expect(() => assertContextPolicy(undefined, true)).toThrow(
      "fresh pi session",
    );
    expect(() =>
      assertContextPolicy(`${PI_CONTEXT_MARKER}\npi prompt`, false),
    ).toThrow("fresh pi session");
  });

  it("wraps pi's prompt from a pi 0.86+ transcript, not an empty one", () => {
    // pi 0.86+ sends no systemPrompt, only a leading system message. Reading
    // the absent field yielded alignPiContext(""): the policy block alone.
    vi.stubEnv("PI_CLAUDE_CLI_CONTEXT", "pi");
    const built = buildSystemPrompt(
      { messages: [leadingSystemMessage(), { role: "user", content: "hi" }] },
      process.cwd(),
    );
    expect(built).toBe(alignPiContext(PI_087_PROMPT));
    expect(isPolicyOnlyPrompt(built)).toBe(false);
    // The replayed prompt: a later patch is part of it on a fresh build.
    const patched = buildSystemPrompt(
      {
        messages: [
          leadingSystemMessage(),
          { role: "user", content: "hi" },
          sectionPatch({ cwd: "<cwd>\n/elsewhere\n</cwd>" }),
        ],
      },
      process.cwd(),
    );
    expect(patched).toContain("<cwd>\n/elsewhere\n</cwd>");
    expect(patched).not.toContain("<cwd>\n/work/app\n</cwd>");
  });

  it("recognises a prompt that is the policy block and nothing else", () => {
    expect(isPolicyOnlyPrompt(alignPiContext(""))).toBe(true);
    expect(isPolicyOnlyPrompt(`${alignPiContext("")}  \n\t\n`)).toBe(true);
    // Earlier policy wording counts: only the block boundary is judged.
    expect(
      isPolicyOnlyPrompt(
        `${PI_CONTEXT_MARKER}\nsome older policy line\n</pi_context_policy>\n\n`,
      ),
    ).toBe(true);
    expect(isPolicyOnlyPrompt(alignPiContext("pi prompt"))).toBe(false);
    expect(isPolicyOnlyPrompt(alignPiContext(PI_087_PROMPT))).toBe(false);
    expect(isPolicyOnlyPrompt("legacy prompt")).toBe(false);
    expect(isPolicyOnlyPrompt(`${PI_CONTEXT_MARKER}\nno closing tag`)).toBe(
      false,
    );
  });
});
