/**
 * Prompt builder for flattening pi conversation history into a labeled text prompt.
 *
 * Follows the reference project's buildPromptBlocks() pattern:
 * - USER: / ASSISTANT: / TOOL RESULT: labels
 * - Content blocks serialized by type
 * - Images in the final user message are translated to Anthropic API format (HIST-02)
 * - Images in non-final messages get placeholder text with console.warn
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_SYSTEM_PROMPT_MODE,
  type SystemPromptMode,
} from "./system-prompt-mode.js";
import {
  mapPiToolNameToClaude,
  translatePiArgsToClaude,
  isCustomToolName,
} from "./tool-mapping.js";

/**
 * Anthropic API content block types for image passthrough.
 * Used when the final user message contains images that need to be
 * translated from pi-ai format to Anthropic format.
 */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

// We use `any` for Context to avoid requiring @earendil-works/pi-ai at dev time.
// At runtime, pi provides the real Context type.

/**
 * Flattens a pi conversation context's messages array into a labeled text prompt
 * suitable for sending to the Claude CLI subprocess.
 *
 * Each message is labeled with its role:
 * - USER: for user messages
 * - ASSISTANT: for assistant messages
 * - TOOL RESULT (historical {toolName}): for tool result messages
 */
/** Module-level counter for placeholder images, reset per buildPrompt call. */
let placeholderImageCount = 0;

/**
 * Translate a pi-ai image block to Anthropic API format.
 * Returns null if the block is missing required data/mimeType fields.
 *
 * pi-ai format:  { type: "image", data: string (base64), mimeType: string }
 * Anthropic format: { type: "image", source: { type: "base64", media_type: string, data: string } }
 */
function translateImageBlock(piBlock: any): AnthropicContentBlock | null {
  if (piBlock.data && piBlock.mimeType) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: piBlock.mimeType,
        data: piBlock.data,
      },
    };
  }
  return null; // Invalid image block, will fall back to placeholder
}

/**
 * Build content blocks for the final user message, translating images
 * from pi-ai format to Anthropic API format.
 *
 * @returns Array of AnthropicContentBlock with text and translated images
 */
function buildFinalUserContent(
  content: string | any[],
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: "" }];
  }

  const blocks: AnthropicContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text ?? "" });
    } else if (block.type === "image") {
      const translated = translateImageBlock(block);
      if (translated) {
        blocks.push(translated);
      } else {
        // Invalid image block: fall back to placeholder text
        blocks.push({
          type: "text",
          text: "[An image was shared here but could not be included]",
        });
        placeholderImageCount++;
      }
    }
    // Unknown block types silently skipped
  }
  return blocks;
}

/**
 * Check if a message content array contains image blocks.
 */
function contentHasImages(content: string | any[]): boolean {
  if (typeof content === "string" || !Array.isArray(content)) return false;
  return content.some((block) => block.type === "image");
}

/**
 * Check if the conversation ends with a custom tool result.
 * If so, build a simplified prompt that presents the result directly
 * instead of replaying the full conversation history with tool labels.
 */
function buildCustomToolResultPrompt(messages: any[]): string | null {
  if (messages.length < 3) return null;

  const last = messages[messages.length - 1];
  if (last.role !== "toolResult") return null;
  if (!last.toolName || !isCustomToolName(last.toolName)) return null;

  // Find the original user message (scan backwards past assistant + toolResult)
  let userMessage: string | null = null;
  for (let i = messages.length - 3; i >= 0; i--) {
    if (messages[i].role === "user") {
      userMessage = userContentToText(messages[i].content);
      break;
    }
  }
  if (!userMessage) return null;

  const toolResult = toolResultContentToText(last.content);
  return `${userMessage}\n\n[The ${last.toolName} tool was called and returned the following result]\n${toolResult}\n\nRespond to the user using the tool result above.`;
}

export function buildPrompt(context: {
  messages: any[];
}): string | AnthropicContentBlock[] {
  // Reset placeholder counter for each call
  placeholderImageCount = 0;

  // Special case: when conversation ends with a custom tool result,
  // present it directly instead of complex history replay
  const customToolPrompt = buildCustomToolResultPrompt(context.messages);
  if (customToolPrompt) {
    // customToolPrompt calls userContentToText which may increment placeholderImageCount
    if (placeholderImageCount > 0) {
      console.warn(
        `[pi-claude-cli] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
      );
    }
    return customToolPrompt;
  }

  // Determine if any message has images worth passing through
  const finalUserIndex = findFinalUserMessageIndex(context.messages);
  const finalUserHasImages =
    finalUserIndex >= 0 &&
    contentHasImages(context.messages[finalUserIndex].content);
  const anyToolResultHasImages = context.messages.some(
    (m: any) => m.role === "toolResult" && toolResultHasImages(m.content),
  );

  if (finalUserHasImages || anyToolResultHasImages) {
    // Build history as text (all messages except the final user message)
    const historyParts: string[] = [];
    const toolResultImageBlocks: AnthropicContentBlock[] = [];
    for (let i = 0; i < context.messages.length; i++) {
      if (i === finalUserIndex) continue; // Skip final user message -- handled separately
      const message = context.messages[i];
      if (message.role === "user") {
        historyParts.push("USER:");
        historyParts.push(userContentToText(message.content));
      } else if (message.role === "assistant") {
        historyParts.push("ASSISTANT:");
        historyParts.push(contentToText(message.content));
      } else if (message.role === "toolResult") {
        if (message.toolName && isCustomToolName(message.toolName)) {
          historyParts.push(`TOOL RESULT (${message.toolName}):`);
        } else {
          const claudeToolName = message.toolName
            ? mapPiToolNameToClaude(message.toolName)
            : "unknown";
          historyParts.push(`TOOL RESULT (historical ${claudeToolName}):`);
        }
        // Extract text portion of tool result
        historyParts.push(toolResultContentToText(message.content));
        // Collect image blocks from tool results for passthrough
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === "image") {
              const translated = translateImageBlock(block);
              if (translated) {
                toolResultImageBlocks.push(translated);
                // Undo the placeholder count from toolResultContentToText since we're passing through
                placeholderImageCount--;
              }
            }
          }
        }
      }
    }

    // Build final user message content blocks
    const finalUserContent =
      finalUserIndex >= 0
        ? buildFinalUserContent(context.messages[finalUserIndex].content)
        : [];

    // Combine: history text + tool result images + final user content blocks
    const result: AnthropicContentBlock[] = [];
    const historyText = historyParts.join("\n");
    if (historyText) {
      result.push({ type: "text", text: historyText });
    }
    // Insert tool result images after history text (Claude sees them in context)
    result.push(...toolResultImageBlocks);
    result.push(...finalUserContent);

    if (placeholderImageCount > 0) {
      console.warn(
        `[pi-claude-cli] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
      );
    }

    return result;
  }

  // No images in final user message: standard text-only path
  const parts: string[] = [];

  for (const message of context.messages) {
    if (message.role === "user") {
      parts.push("USER:");
      parts.push(userContentToText(message.content));
    } else if (message.role === "assistant") {
      parts.push("ASSISTANT:");
      parts.push(contentToText(message.content));
    } else if (message.role === "toolResult") {
      if (message.toolName && isCustomToolName(message.toolName)) {
        // Custom tools: don't reference MCP tool name. Present result plainly.
        parts.push(`TOOL RESULT (${message.toolName}):`);
      } else {
        const claudeToolName = message.toolName
          ? mapPiToolNameToClaude(message.toolName)
          : "unknown";
        parts.push(`TOOL RESULT (historical ${claudeToolName}):`);
      }
      parts.push(toolResultContentToText(message.content));
    }
  }

  if (placeholderImageCount > 0) {
    console.warn(
      `[pi-claude-cli] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
    );
  }

  return parts.join("\n") || "";
}

/**
 * Find the index of the last user message in the messages array.
 * Returns -1 if no user message found.
 */
function findFinalUserMessageIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

/**
 * Tool guidance in Claude Code's vocabulary, used only in `pi` prompt mode.
 *
 * Replacing Claude Code's system prompt means the model still receives its
 * tool *schemas* from the API but loses the prose about when and how to use
 * them. Pi's own prose can't stand in unedited: it names pi's tools
 * (`read`, `edit`, `grep`, `find`, `ls`) and pi's parameters (`path`,
 * `oldText`, `newText`), none of which match what the model is actually
 * handed (`Read`, `Edit`, `Grep`, `Glob`, with `file_path`, `old_string`,
 * `new_string`). Left in place it is not merely useless but actively
 * misleading, so it is swapped for this.
 */
const CLAUDE_CODE_TOOLS_SECTION = `Available tools:
- Read: Read file contents (key param: file_path)
- Write: Create or overwrite files (key params: file_path, content)
- Edit: Make precise edits with exact text replacement (key params: file_path, old_string, new_string)
- Bash: Execute bash commands (key param: command)
- Grep: Search file contents for patterns (key params: pattern, path)
- Glob: Find files by glob pattern (key params: pattern, path)

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Prefer Grep and Glob over Bash for file exploration (faster, respects .gitignore)
- Use Read to examine files before editing
- Use Edit for precise changes (old_string must match exactly)
- Use Write only for new files or complete rewrites
- When summarizing your actions, output plain text directly — do NOT use Bash to display what you did
- Be concise in your responses
- Show file paths clearly when working with files`;

/**
 * Swap pi's tool documentation for Claude Code's.
 *
 * Pi's prompt is a sequence of blank-line-separated blocks; the tool material
 * runs from the `Available tools:` block through the `Guidelines:` block
 * (verified against pi 0.84.2, where those are blocks 1 and 3 of 5). Both
 * anchors must be present and in order, otherwise the prompt is returned
 * untouched — if pi restyles its prompt the failure mode should be "kept the
 * original", never a mangled one.
 *
 * Exported for tests.
 */
export function rewritePiToolSections(systemPrompt: string): string {
  const blocks = systemPrompt.split("\n\n");

  const start = blocks.findIndex((b) => b.startsWith("Available tools:"));
  const end = blocks.findIndex((b) => b.startsWith("Guidelines:"));
  if (start === -1 || end === -1 || end < start) return systemPrompt;

  const kept = blocks.filter((_, i) => i < start || i > end);
  // Reinstate the replacement where the originals were, so the intro still
  // reads into it and anything after (pi's docs section) still follows.
  kept.splice(start, 0, CLAUDE_CODE_TOOLS_SECTION);
  return kept.join("\n\n");
}

/**
 * Builds the system prompt from the context's systemPrompt field,
 * appending AGENTS.md content if found (walking up from cwd, then global fallback).
 * Sanitizes .pi references to .claude for Claude Code compatibility.
 *
 * In `pi` mode the caller passes the prompt to `--system-prompt`, replacing
 * Claude Code's own, so pi's tool sections are rewritten into Claude Code's
 * names first. In `claude` mode the prompt is appended to Claude Code's and
 * pi's wording is left exactly as pi wrote it.
 */
export function buildSystemPrompt(
  context: { systemPrompt?: string; messages: any[] },
  cwd: string,
  mode: SystemPromptMode = DEFAULT_SYSTEM_PROMPT_MODE,
): string {
  const parts: string[] = [];

  if (context.systemPrompt) {
    parts.push(
      mode === "pi"
        ? rewritePiToolSections(context.systemPrompt)
        : context.systemPrompt,
    );
  }

  // Look for AGENTS.md
  const agentsPath = resolveAgentsMdPath(cwd);
  if (agentsPath) {
    try {
      const content = readFileSync(agentsPath, "utf-8");
      const sanitized = sanitizeAgentsContent(content);
      parts.push(sanitized);
    } catch {
      // If we can't read it, skip silently
    }
  }

  // The provider never resumes, so every turn replays the whole transcript and
  // the model has to recognise its own completed work in it. Without this the
  // model re-issues the tool call it just made and the loop never advances —
  // the livelock recorded as issue #12.
  //
  // The wording matters. An earlier version said "Do NOT attempt to re-call
  // tools that already have results", which was written for the first turn
  // (where every result is genuinely historical). Mid-loop it reads as "stop
  // calling tools" and fights the break-early design, which depends on the
  // model proposing the NEXT call.
  if (context.messages?.some((m: any) => m.role === "toolResult")) {
    parts.push(
      "The conversation below is the transcript of this session so far, including tool calls you " +
        "already made and the results they returned. Those calls have already run: their results are " +
        "final and must not be requested again. Continue from the end of the transcript — either make " +
        "the next tool call the task needs, or give the final answer if every step is done.",
    );
  }

  return parts.join("\n\n");
}

/**
 * Converts user message content to text.
 * Handles string content and array of content blocks.
 * Image blocks are replaced with placeholder text (HIST-02).
 * Increments the module-level placeholderImageCount for each image.
 */
function userContentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text ?? "");
    } else if (block.type === "image") {
      texts.push("[An image was shared here but could not be included]");
      placeholderImageCount++;
    }
    // Unknown block types silently skipped
  }
  return texts.join("\n");
}

/**
 * Converts assistant message content to text.
 * Handles string content and array of content blocks (text, thinking, toolCall).
 */
function contentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "thinking") return ""; // Skip thinking — internal reasoning, not conversation
      if (block.type === "toolCall") {
        const isCustom = isCustomToolName(block.name);
        if (isCustom) {
          // Custom tools: don't reference the MCP tool name — Claude might try to re-call it.
          // Just note what was done. The result follows as a TOOL RESULT message.
          const argsStr = block.arguments
            ? JSON.stringify(block.arguments)
            : "{}";
          return `[Used ${block.name} tool with args: ${argsStr}]`;
        }
        const claudeName = mapPiToolNameToClaude(block.name);
        const claudeArgs =
          block.arguments && typeof block.arguments === "object"
            ? translatePiArgsToClaude(
                block.name,
                block.arguments as Record<string, unknown>,
              )
            : block.arguments;
        const argsStr = claudeArgs ? JSON.stringify(claudeArgs) : "{}";
        return `Historical tool call (non-executable): ${claudeName} args=${argsStr}`;
      }
      // Unknown block types are represented as a placeholder
      return `[${block.type}]`;
    })
    .join("\n");
}

/**
 * Converts tool result content to text.
 * Handles string content and array of content blocks.
 * Image blocks get placeholder text (actual image passthrough handled separately).
 */
function toolResultContentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text ?? "");
    } else if (block.type === "image") {
      texts.push("[An image was shared here but could not be included]");
      placeholderImageCount++;
    }
  }
  return texts.join("\n");
}

/**
 * Check if a tool result content array contains image blocks.
 */
function toolResultHasImages(content: string | any[]): boolean {
  if (typeof content === "string" || !Array.isArray(content)) return false;
  return content.some((block) => block.type === "image");
}

/**
 * Walk up from cwd looking for AGENTS.md, fall back to ~/.pi/agent/AGENTS.md.
 */
function resolveAgentsMdPath(cwd: string): string | undefined {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, "AGENTS.md");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Fall back to global path
  const globalPath = join(homedir(), ".pi", "agent", "AGENTS.md");
  if (existsSync(globalPath)) return globalPath;

  return undefined;
}

/**
 * Sanitize .pi references to .claude in AGENTS.md content
 * for Claude Code compatibility.
 */
function sanitizeAgentsContent(content: string): string {
  let sanitized = content;
  // ~/.pi -> ~/.claude
  sanitized = sanitized.replace(/~\/\.pi\b/gi, "~/.claude");
  // .pi/ -> .claude/ (at word boundary or after whitespace/quotes)
  sanitized = sanitized.replace(/(^|[\s'"`])\.pi\//g, "$1.claude/");
  // Remaining standalone .pi references
  sanitized = sanitized.replace(/\b\.pi\b/gi, ".claude");
  return sanitized;
}
