/** Configurable context has one loader; execution remains Claude-native. */
import { TOOL_MAPPINGS } from "./tool-mapping.js";

export const PI_CONTEXT_MARKER = '<pi_context_policy version="1">';
export class ContextPolicyError extends Error {}
export const MIN_CONTEXT_CLI_VERSION = "2.1.263";

/** Do not assume older CLIs honor memory/skill isolation environment controls. */
export function assertContextCliVersion(output: string): void {
  const match = /(\d+)\.(\d+)\.(\d+)(?=\s|$)/.exec(output.trim());
  const parts = match?.slice(1).map(Number);
  const floor = MIN_CONTEXT_CLI_VERSION.split(".").map(Number);
  const difference = parts
    ?.map((part, i) => part - floor[i])
    .find((n) => n !== 0);
  if (!parts || (difference !== undefined && difference < 0)) {
    throw new ContextPolicyError(
      `Pi context requires Claude Code ${MIN_CONTEXT_CLI_VERSION}+ (the tested isolation controls). Update Claude Code before using this policy.`,
    );
  }
}

export function usesPiContext(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.PI_CLAUDE_CLI_CONTEXT ?? "legacy").trim().toLowerCase();
  if (value === "pi") return true;
  if (!value || value === "legacy") return false;
  throw new ContextPolicyError(
    "PI_CLAUDE_CLI_CONTEXT must be 'pi' or 'legacy'.",
  );
}

/**
 * Only edit pi's generated preamble, never user directives, project files or
 * skill contents. Keep custom-tool guidance (especially artifacts) intact.
 * The boundary is intentionally narrow: unknown/custom prompts pass through
 * with an explicit vocabulary binding rather than being rewritten blindly.
 */
export function alignPiContext(prompt: string): string {
  const boundary = prompt.indexOf("\n\nPi documentation (");
  if (
    prompt.startsWith(
      "You are an expert coding assistant operating inside pi,",
    ) &&
    boundary !== -1
  ) {
    const names = new Map(TOOL_MAPPINGS.map((m) => [m.pi, m.claude]));
    const descriptions: Record<string, string> = {
      read: "Read file contents using the native Read schema (file_path).",
      write:
        "Create or overwrite a file using the native Write schema (file_path, content).",
      edit: "Replace exact text using native Edit (file_path, old_string, new_string); use separate calls for disjoint replacements.",
      bash: "Execute commands using the native Bash schema.",
    };
    let preamble = prompt.slice(0, boundary);
    preamble = preamble.replace(
      /(^Available tools:\n)([\s\S]*?)(?=\n\n)/m,
      (_, heading, tools: string) =>
        heading +
        // Grep/Glob are not present in every CLI/model inventory. Do not
        // advertise them based solely on pi's registry; binding below covers search.
        tools
          .replace(/^- (?:grep|find):.*(?:\n|$)/gm, "")
          .replace(/^(- )(\w+)(:.*)$/gm, (_, lead, name, rest) =>
            names.has(name)
              ? `${lead}${names.get(name)}: ${descriptions[name]}`
              : `${lead}mcp__custom-tools__${name}${rest}`,
          ),
    );
    // These are pi Edit's semantics, not Claude Code Edit's. Other tool and
    // artifact guidelines survive, as does the complete suffix below.
    preamble = preamble
      .split("\n")
      // `edits[]` is pi's edit signature; native Edit takes one old_string per
      // call. So ANY line naming that array is wrong here, whatever its
      // wording — that is the rule, rather than a list of the phrasings pi
      // happens to ship. Enumerating them missed "Keep edits[].oldText as
      // small as possible…" in pi 0.85.1, and it reached live sessions.
      .filter((line) => !line.includes("edits[]"))
      .map((line) =>
        line.replace(
          /\b(Use|use|Prefer|prefer) (read|write|edit|bash|grep|find)\b/g,
          (_, verb, tool) =>
            `${verb} ${tool === "grep" || tool === "find" ? "available native search tools (or Bash)" : names.get(tool)}`,
        ),
      )
      .join("\n");
    prompt = preamble + prompt.slice(boundary);
  }
  return [
    PI_CONTEXT_MARKER,
    "pi supplies the project instructions, skill index and custom integrations below. Do not independently discover Claude skills or memory.",
    "Claude Code retains its default system prompt and native coding tools. In pi-authored instructions, read/write/edit/bash refer to native Read/Write/Edit/Bash. For grep/find, use native search tools only if actually advertised; otherwise use Bash. Use actual tool schemas, not pi argument names.",
    "Native Edit uses file_path, old_string and new_string, not pi's multi-edit array. Native Read/Write use file_path. Other pi tools use their advertised mcp__custom-tools__ names and unchanged schemas; this includes artifacts and the pi MCP gateway.",
    "Load a listed pi skill with native Read at its exact path. Preserve .pi paths; they are not aliases for .claude. Only the supplied skill index defines the available pi skills.",
    "</pi_context_policy>",
    "",
    prompt,
  ].join("\n");
}

/** A policy change cannot safely reuse the CLI's hidden history/pinned prompt. */
export function assertContextPolicy(
  storedPrompt: string | undefined,
  piContext: boolean,
): void {
  if ((storedPrompt?.startsWith(PI_CONTEXT_MARKER) ?? false) !== piContext) {
    throw new ContextPolicyError(
      "Claude context policy changed (or its saved prompt is missing). Start a fresh pi session; the existing Claude transcript was not migrated.",
    );
  }
}
