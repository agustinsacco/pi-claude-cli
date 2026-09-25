/**
 * The transcript shape pi 0.86+ hands a provider, captured from pi 0.87.1.
 *
 * pi-ai's `normalizeContext` leaves no `Context.systemPrompt`: the prompt is a
 * leading `role: "system"` message. pi-coding-agent writes it as named
 * `sections` with empty `content` (`buildSystemPromptState`), and declares the
 * tool loadout on the same message as `toolsAdded` (agent-loop
 * `declareToolChanges`). Later system messages patch sections by name or
 * change tools. The section texts below are what 0.87.1's
 * `buildSystemPromptSections` produced for this input (docs paths shortened),
 * and PI_087_PROMPT is its `buildSystemPrompt` rendering of them.
 *
 * The devDependency pins pi-ai 0.84.2, which predates system messages, so the
 * real `normalizeContext` is not importable here; this fixture stands in.
 * The mirror in src/prompt-builder.ts was checked against the real pi-ai
 * 0.87.1 `getCurrentSystemPrompt` / `collapseSystemMessages` on these shapes.
 */

export const PI_087_SECTIONS: Record<string, string> = {
  preamble:
    "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
  tools:
    "<tools>\n- read: Read file contents\n- bash: Execute bash commands\n- edit: Make precise file edits\n- write: Create or overwrite files\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n</tools>",
  rules:
    "<rules>\n- Use bash for file operations like ls, rg, find\n- Be concise in your responses\n- Show file paths clearly when working with files\n</rules>",
  docs: "<docs>\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n- Main documentation: /opt/pi/README.md\n</docs>",
  project_context:
    '<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/work/app/AGENTS.md">\nRun npm test before committing.\n</project_instructions>\n</project_context>',
  cwd: "<cwd>\n/work/app\n</cwd>",
};

/** The prompt text pi-ai renders from PI_087_SECTIONS. */
export const PI_087_PROMPT = Object.values(PI_087_SECTIONS).join("\n\n");

/** A pi custom tool, declared to the model through `toolsAdded`. */
export const ARTIFACT_TOOL = {
  name: "artifact_create",
  description: "TOOL-DESCRIPTION-SENTINEL: publish an artifact",
  parameters: { type: "object", properties: {} },
};

/** The leading system message of a 0.87.1 transcript. */
export const leadingSystemMessage = () => ({
  role: "system",
  content: "",
  sections: { ...PI_087_SECTIONS },
  toolsAdded: [ARTIFACT_TOOL],
  timestamp: 1_000,
});

/** A later system message patching sections (`null` removes one). */
export const sectionPatch = (
  sections: Record<string, string | null>,
  timestamp = 2_000,
) => ({ role: "system", content: "", sections, timestamp });

/** A later system message that only changes the tool loadout. */
export const toolChange = (timestamp = 2_000) => ({
  role: "system",
  content: "",
  toolsRemoved: [{ name: ARTIFACT_TOOL.name }],
  timestamp,
});
