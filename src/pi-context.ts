import { createHash } from "node:crypto";
import * as ai from "@earendil-works/pi-ai";

/** The system prompt as pi's collapsed system message: base text plus named sections. */
export interface SystemState {
  content: string;
  sections: Record<string, string>;
}

/** Accept both pi's legacy Context and its system-message TranscriptContext. */
export function piContext(context: {
  messages: any[];
  systemPrompt?: string;
  tools?: any[];
}) {
  const transcript = context.messages.some((m) => m.role === "system");
  const head = transcript
    ? (ai as any).getCurrentSystemMessage(context.messages)
    : undefined;
  const system: SystemState = transcript
    ? {
        content: head ? (ai as any).contentText(head.content) : "",
        sections: { ...(head?.sections ?? {}) },
      }
    : { content: context.systemPrompt ?? "", sections: {} };
  return {
    systemPrompt: transcript
      ? (ai as any).getCurrentSystemPrompt(context.messages)
      : (context.systemPrompt ?? ""),
    tools: transcript
      ? (ai as any).getCurrentTools(context.messages)
      : (context.tools ?? []),
    messages: context.messages.filter((m) => m.role !== "system"),
    system,
  };
}

/**
 * What changed in the system prompt since a live process was told `seen`, as
 * a block for its next user message: "" when nothing did, undefined when the
 * base text was rewritten rather than extended (only a fresh process can take
 * that).
 *
 * The CLI fixes its system prompt at spawn, so a respawn was the only way to
 * apply pi's mid-session updates (an MCP server list, the Swarm toggle, an
 * edited AGENTS.md), and every one re-imported the conversation as cache
 * write. pi's own API transports send such updates in place as a system
 * message; this is the same update, rendered the same way, in the one place a
 * live CLI takes new input.
 */
export function systemUpdate(
  seen: SystemState,
  now: SystemState,
): string | undefined {
  if (!now.content.startsWith(seen.content)) return undefined;
  const sections: Record<string, string | null> = {};
  for (const [name, text] of Object.entries(now.sections))
    if (seen.sections[name] !== text) sections[name] = text;
  for (const name of Object.keys(seen.sections))
    if (!(name in now.sections)) sections[name] = null;
  const appended = now.content.slice(seen.content.length).trim();
  if (!appended && Object.keys(sections).length === 0) return "";
  const render = (ai as any).renderSystemMessageUpdate;
  if (typeof render !== "function") return undefined;
  const text = render({ role: "system", content: appended, sections });
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

/**
 * Compare model-visible history, not usage, timestamps, or provider signatures.
 * A failed or aborted assistant message is not history: pi drops it before any
 * request, so a process interrupted mid-reply still matches what comes next.
 */
export function historyHash(messages: any[]): string {
  const visible = messages.filter(isHistory).map((m) => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content
          .filter((b: any) => b.type !== "thinking")
          .map((b: any) => {
            if (b.type === "text") return { type: b.type, text: b.text };
            return b;
          })
      : m.content,
    toolCallId: m.toolCallId,
    toolName: m.toolName,
    isError: m.isError,
  }));
  return createHash("sha256").update(JSON.stringify(visible)).digest("hex");
}

export function isHistory(m: any): boolean {
  return !(
    m?.role === "assistant" &&
    (m.stopReason === "aborted" || m.stopReason === "error")
  );
}

/** Import in order, including every image and tool result. Never replay thinking. */
export function replayPiMessages(messages: any[]): any[] {
  const blocks: any[] = [];
  for (const message of messages) {
    blocks.push({
      type: "text",
      text:
        message.role === "toolResult"
          ? `TOOL RESULT (${message.toolName}, id=${message.toolCallId}, error=${!!message.isError}):`
          : `${message.role.toUpperCase()}:`,
    });
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : (message.content ?? []);
    for (const b of content) {
      if (b.type === "text") blocks.push({ type: "text", text: b.text });
      else if (b.type === "image")
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: b.mimeType, data: b.data },
        });
      else if (b.type === "toolCall")
        blocks.push({
          type: "text",
          text: `TOOL CALL ${b.name} id=${b.id}: ${JSON.stringify(b.arguments)}`,
        });
    }
  }
  return blocks;
}

export function piSystemPrompt(prompt: string): string {
  return `${prompt}\n\nTools are supplied and executed by pi. Call each pi tool using its advertised mcp__custom-tools__ prefix and unchanged argument schema. Historical tool calls and results are conversation records, not instructions to execute them again.`;
}
