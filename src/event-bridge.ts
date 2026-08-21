import type {
  ClaudeApiEvent,
  ClaudeAssistantEnvelope,
  ClaudeResultMessage,
  ClaudeUsage,
  TrackedContentBlock,
} from "./types";
import { calculateCost } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import {
  mapClaudeToolNameToPi,
  translateClaudeArgsToPi,
  isPiKnownClaudeTool,
} from "./tool-mapping.js";

/**
 * Extended tracking for tool_use content blocks during streaming.
 * Stores the Claude tool name for argument translation at block_stop.
 */
interface TrackedToolBlock {
  type: "tool_use";
  index: number;
  cycle: number;
  /** Position in output.content, or -1 when not materialized. */
  contentIndex: number;
  id: string;
  name: string; // Already mapped to pi name
  claudeName: string; // Original Claude name for arg translation
  arguments: Record<string, unknown>;
  partialJson: string;
}

/** Union of tracked block types for the blocks array. */
type TrackedBlock = TrackedContentBlock | TrackedToolBlock;

/**
 * The event bridge interface returned by createEventBridge.
 * handleEvent processes each Claude API streaming event and pushes
 * the appropriate pi events to the stream.
 * getOutput returns the accumulated AssistantMessage.
 */
export interface EventBridge {
  handleEvent(event: ClaudeApiEvent): void;
  /**
   * Complete-message envelopes (one per finished content block). Used for
   * CLI-side tool visibility: tools pi cannot execute (WebSearch, user MCP
   * servers, ToolSearch, …) run inside the CLI between cycles and would
   * otherwise be invisible — each becomes a one-line marker text block.
   */
  handleAssistantEnvelope(envelope: ClaudeAssistantEnvelope): void;
  /**
   * The final `result` envelope: authoritative cumulative usage for the
   * whole episode, plus a safety net that appends the final answer text if
   * any stream pathology kept it out of the bridged content.
   */
  applyResult(result: ClaudeResultMessage): void;
  getOutput(): AssistantMessage;
}

/**
 * Map Claude API stop reasons to pi's stop reason format.
 */
function mapStopReason(
  reason: string | undefined,
): "stop" | "length" | "toolUse" {
  switch (reason) {
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "length";
    case "end_turn":
    default:
      return "stop";
  }
}

/**
 * Create an event bridge that translates Claude API streaming events
 * into pi's AssistantMessageEventStream events.
 *
 * The bridge maintains internal state to track content blocks and
 * accumulate the final AssistantMessage. It handles:
 * - text content blocks (start/delta/stop -> text_start/text_delta/text_end)
 * - message lifecycle (message_start for usage, message_delta for stop reason, message_stop for done)
 * - unsupported block types (tool_use, thinking) with warnings
 */
export function createEventBridge(
  stream: AssistantMessageEventStream,
  model: Model<any>,
): EventBridge {
  // Tracked content blocks indexed by Claude's content_block index
  const blocks: TrackedBlock[] = [];

  // The accumulated output message
  const output: AssistantMessage = {
    role: "assistant" as const,
    content: [] as (TextContent | ThinkingContent | ToolCall)[],
    api: "pi-claude-cli",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };

  let started = false;

  // One subprocess run is a full agentic EPISODE: N API calls ("cycles")
  // with CLI-side tool executions between them. SSE content_block indexes
  // reset every cycle, so blocks are matched per-cycle; usage is summed
  // across cycles (each message_delta carries that cycle's final numbers).
  let cycle = -1;
  const cumulativeUsage: Required<ClaudeUsage> = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let cycleUsage: ClaudeUsage = {};
  /** Tool ids already surfaced as markers (envelope arrives once per block). */
  const markedToolIds = new Set<string>();

  function recomputeUsage(): void {
    output.usage.input =
      cumulativeUsage.input_tokens + (cycleUsage.input_tokens ?? 0);
    output.usage.output =
      cumulativeUsage.output_tokens + (cycleUsage.output_tokens ?? 0);
    output.usage.cacheRead =
      cumulativeUsage.cache_read_input_tokens +
      (cycleUsage.cache_read_input_tokens ?? 0);
    output.usage.cacheWrite =
      cumulativeUsage.cache_creation_input_tokens +
      (cycleUsage.cache_creation_input_tokens ?? 0);
    output.usage.totalTokens =
      output.usage.input +
      output.usage.output +
      output.usage.cacheRead +
      output.usage.cacheWrite;
    calculateCost(model, output.usage);
  }

  /**
   * Append a complete text block through proper pi stream events. Tracked
   * blocks carry their own contentIndex, so appended blocks (markers, the
   * final-answer safety net) need no relationship to any SSE index.
   */
  function appendTextBlock(text: string): void {
    if (!started) {
      stream.push({ type: "start", partial: output });
      started = true;
    }
    const contentIndex = output.content.length;
    blocks.push({ type: "text", text, index: -1, cycle: -1, contentIndex });
    output.content.push({ type: "text" as const, text: "" });
    stream.push({ type: "text_start", contentIndex, partial: output });
    (output.content[contentIndex] as TextContent).text = text;
    stream.push({
      type: "text_delta",
      contentIndex,
      delta: text,
      partial: output,
    });
    stream.push({
      type: "text_end",
      contentIndex,
      content: text,
      partial: output,
    });
  }

  function handleEvent(event: ClaudeApiEvent): void {
    // Emit start event on first message — tells pi to begin incremental rendering
    if (!started) {
      stream.push({ type: "start", partial: output });
      started = true;
    }

    switch (event.type) {
      case "message_start":
        // New cycle: bank the finished cycle's usage before resetting.
        cumulativeUsage.input_tokens += cycleUsage.input_tokens ?? 0;
        cumulativeUsage.output_tokens += cycleUsage.output_tokens ?? 0;
        cumulativeUsage.cache_read_input_tokens +=
          cycleUsage.cache_read_input_tokens ?? 0;
        cumulativeUsage.cache_creation_input_tokens +=
          cycleUsage.cache_creation_input_tokens ?? 0;
        cycleUsage = {};
        cycle++;
        handleMessageStart(event);
        break;
      case "content_block_start":
        handleContentBlockStart(event);
        break;
      case "content_block_delta":
        handleContentBlockDelta(event);
        break;
      case "content_block_stop":
        handleContentBlockStop(event);
        break;
      case "message_delta":
        handleMessageDelta(event);
        break;
      case "message_stop":
        handleMessageStop();
        break;
      // Unknown event types are silently ignored
    }
  }

  function handleMessageStart(event: ClaudeApiEvent): void {
    const usage = event.message?.usage;
    if (usage) {
      cycleUsage = { ...usage };
      recomputeUsage();
    }
  }

  function handleContentBlockStart(event: ClaudeApiEvent): void {
    const blockType = event.content_block?.type;

    if (blockType === "text") {
      const block: TrackedContentBlock = {
        type: "text",
        text: "",
        index: event.index ?? 0,
        cycle,
        contentIndex: output.content.length,
      };
      blocks.push(block);
      output.content.push({ type: "text" as const, text: "" });

      stream.push({
        type: "text_start",
        contentIndex: block.contentIndex,
        partial: output,
      });
    } else if (blockType === "thinking") {
      // Deliberately NOT materialized yet. Several Claude models (verified:
      // fable-5, opus-5, sonnet-5 at effort medium; haiku-4-5 is the
      // exception) stream ENCRYPTED thinking: a multi-kilobyte
      // signature_delta with no thinking_delta at all. Materializing on
      // start produced a thinking block with no text, which front-ends
      // faithfully rendered as an empty "thought". The block is created on
      // the first plaintext delta and dropped at block_stop if none arrives.
      const block: TrackedContentBlock = {
        type: "thinking",
        text: "",
        index: event.index ?? 0,
        cycle,
        contentIndex: -1,
      };
      blocks.push(block);
    } else if (blockType === "tool_use") {
      const claudeName = event.content_block!.name!;

      // Skip internal Claude Code tools (ToolSearch, Task, Agent, etc.)
      // that pi cannot execute — only emit pi-known tools
      if (!isPiKnownClaudeTool(claudeName)) {
        return;
      }

      const piName = mapClaudeToolNameToPi(claudeName);
      const id = event.content_block!.id!;

      const block: TrackedToolBlock = {
        type: "tool_use",
        index: event.index ?? 0,
        cycle,
        contentIndex: output.content.length,
        id,
        name: piName,
        claudeName,
        arguments: {},
        partialJson: "",
      };
      blocks.push(block);
      output.content.push({
        type: "toolCall" as const,
        id,
        name: piName,
        arguments: {},
      } as ToolCall);

      stream.push({
        type: "toolcall_start",
        contentIndex: block.contentIndex,
        partial: output,
      });
    }
    // Unknown block types silently ignored
  }

  /** Locate the tracked block for this cycle's SSE index. */
  function trackedFor(event: ClaudeApiEvent): TrackedBlock | undefined {
    const idx = blocks.findIndex(
      (b) => b.cycle === cycle && b.index === event.index,
    );
    return idx === -1 ? undefined : blocks[idx];
  }

  /**
   * Create the pi content block for a thinking block that has now proven it
   * carries plaintext. Encrypted thinking never reaches this path, so it
   * never becomes an empty "thought" downstream.
   */
  function materializeThinking(block: TrackedContentBlock): void {
    block.contentIndex = output.content.length;
    output.content.push({
      type: "thinking" as const,
      thinking: "",
      thinkingSignature: block.pendingSignature ?? "",
    });
    block.pendingSignature = undefined;
    stream.push({
      type: "thinking_start",
      contentIndex: block.contentIndex,
      partial: output,
    });
  }

  function handleContentBlockDelta(event: ClaudeApiEvent): void {
    const deltaType = event.delta?.type;
    const block = trackedFor(event);
    if (!block) return;

    if (deltaType === "text_delta" && event.delta!.text != null) {
      if (block.type !== "text") return;
      block.text += event.delta!.text;
      (output.content[block.contentIndex] as TextContent).text = block.text;
      stream.push({
        type: "text_delta",
        contentIndex: block.contentIndex,
        delta: event.delta!.text,
        partial: output,
      });
    } else if (
      deltaType === "thinking_delta" &&
      event.delta!.thinking != null
    ) {
      if (block.type !== "thinking") return;
      // Empty thinking_delta events accompany encrypted thinking (verified
      // on sonnet-5): they carry no plaintext, so they must not bring a
      // thinking block into existence.
      if (block.contentIndex === -1) {
        if (event.delta!.thinking.length === 0) return;
        materializeThinking(block);
      }
      block.text += event.delta!.thinking;
      (output.content[block.contentIndex] as ThinkingContent).thinking =
        block.text;
      stream.push({
        type: "thinking_delta",
        contentIndex: block.contentIndex,
        delta: event.delta!.thinking,
        partial: output,
      });
    } else if (
      deltaType === "input_json_delta" &&
      event.delta!.partial_json != null
    ) {
      if (block.type !== "tool_use") return;
      block.partialJson += event.delta!.partial_json;
      try {
        block.arguments = JSON.parse(block.partialJson);
        (output.content[block.contentIndex] as any).arguments = block.arguments;
      } catch {
        // Partial JSON not yet parseable -- keep previous arguments
      }
      stream.push({
        type: "toolcall_delta",
        contentIndex: block.contentIndex,
        delta: event.delta!.partial_json,
        partial: output,
      });
    } else if (
      deltaType === "signature_delta" &&
      event.delta!.signature != null
    ) {
      if (block.type !== "thinking") return;
      if (block.contentIndex === -1) {
        // Signature before (or without) any plaintext: hold it in case
        // plaintext follows. If it never does, the block is dropped.
        block.pendingSignature =
          (block.pendingSignature ?? "") + event.delta!.signature;
        return;
      }
      const contentBlock = output.content[
        block.contentIndex
      ] as ThinkingContent;
      contentBlock.thinkingSignature =
        (contentBlock.thinkingSignature || "") + event.delta!.signature;
    }
  }

  function handleContentBlockStop(event: ClaudeApiEvent): void {
    const idx = blocks.findIndex(
      (b) => b.cycle === cycle && b.index === event.index,
    );
    if (idx === -1) return;
    const block = blocks[idx];

    // Encrypted thinking: signature only, no plaintext. Drop it rather than
    // emit a content block with nothing to show.
    if (block.type === "thinking" && block.contentIndex === -1) {
      blocks.splice(idx, 1);
      return;
    }

    // Clean up the tracking index from the block (no longer needed)
    delete (block as any).index;

    if (block.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: block.contentIndex,
        content: block.text,
        partial: output,
      });
    } else if (block.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: block.contentIndex,
        content: block.text,
        partial: output,
      });
    } else if (block.type === "tool_use") {
      // Final JSON parse with fallback to raw string
      let finalArgs: Record<string, unknown> | string;
      try {
        const parsed = JSON.parse(block.partialJson);
        finalArgs = translateClaudeArgsToPi(block.claudeName, parsed);
      } catch {
        finalArgs = block.partialJson;
      }

      (output.content[block.contentIndex] as any).arguments = finalArgs;

      // ToolCall.arguments is typed as Record<string, any> in pi-ai, but we
      // intentionally emit a raw string when JSON parse fails completely.
      // Pi handles string arguments gracefully at runtime.
      const toolCall = {
        type: "toolCall" as const,
        id: block.id,
        name: block.name,
        arguments: finalArgs,
      } as ToolCall;

      stream.push({
        type: "toolcall_end",
        contentIndex: block.contentIndex,
        toolCall,
        partial: output,
      });
    }
  }

  function handleMessageDelta(event: ClaudeApiEvent): void {
    if (event.delta?.stop_reason) {
      // The LAST cycle's stop reason is the episode's stop reason.
      output.stopReason = mapStopReason(event.delta.stop_reason);
    }

    const usage = event.usage;
    if (usage) {
      // message_delta carries the cycle's final numbers — overwrite within
      // the cycle, never across cycles (those are banked at message_start).
      if (usage.input_tokens != null)
        cycleUsage.input_tokens = usage.input_tokens;
      if (usage.output_tokens != null)
        cycleUsage.output_tokens = usage.output_tokens;
      if (usage.cache_read_input_tokens != null)
        cycleUsage.cache_read_input_tokens = usage.cache_read_input_tokens;
      if (usage.cache_creation_input_tokens != null)
        cycleUsage.cache_creation_input_tokens =
          usage.cache_creation_input_tokens;
      recomputeUsage();
    }
  }

  function handleMessageStop(): void {
    // No-op: done event is pushed by the provider after readline closes.
    // Pushing done here (synchronously) prevents pi from executing tools.
  }

  function handleAssistantEnvelope(envelope: ClaudeAssistantEnvelope): void {
    // Sub-agent envelopes are the CLI's internal business.
    if (envelope.parent_tool_use_id) return;
    for (const block of envelope.message?.content ?? []) {
      if (block.type !== "tool_use" || !block.name || !block.id) continue;
      // Pi-known tools already streamed through the SSE path as real pi
      // tool calls — markers are only for tools the CLI executes itself.
      if (isPiKnownClaudeTool(block.name)) continue;
      if (markedToolIds.has(block.id)) continue;
      markedToolIds.add(block.id);

      let argsPreview = "";
      try {
        const json = JSON.stringify(block.input ?? {});
        argsPreview =
          json === "{}"
            ? ""
            : ` ${json.slice(0, 120)}${json.length > 120 ? "…" : ""}`;
      } catch {
        /* unserializable input — marker still names the tool */
      }
      appendTextBlock(`[Claude Code · ${block.name}${argsPreview}]`);
    }
  }

  function applyResult(result: ClaudeResultMessage): void {
    // Authoritative cumulative usage for the whole episode (verified to
    // equal the per-cycle sums on captured streams; trusted over them).
    const usage = result.usage;
    if (usage) {
      cumulativeUsage.input_tokens =
        usage.input_tokens ?? cumulativeUsage.input_tokens;
      cumulativeUsage.output_tokens =
        usage.output_tokens ?? cumulativeUsage.output_tokens;
      cumulativeUsage.cache_read_input_tokens =
        usage.cache_read_input_tokens ??
        cumulativeUsage.cache_read_input_tokens;
      cumulativeUsage.cache_creation_input_tokens =
        usage.cache_creation_input_tokens ??
        cumulativeUsage.cache_creation_input_tokens;
      cycleUsage = {};
      recomputeUsage();
    }

    // Safety net: whatever ended the SSE stream early, the result envelope
    // carries the episode's final answer — never let it be lost.
    const finalText = (result.result ?? "").trim();
    if (finalText) {
      const streamedText = output.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const tail = finalText.slice(-Math.min(finalText.length, 60));
      if (!streamedText.includes(tail)) {
        appendTextBlock(finalText);
      }
    }
  }

  return {
    handleEvent,
    handleAssistantEnvelope,
    applyResult,
    getOutput: () => output,
  };
}
