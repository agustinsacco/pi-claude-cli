// Wire protocol types for Claude CLI stream-json NDJSON communication

// NDJSON message types from Claude CLI stdout

export interface ClaudeStreamEventMessage {
  type: "stream_event";
  event: ClaudeApiEvent;
}

/**
 * Per-model spend for the episode, keyed by model id.
 *
 * This is the ONLY place the CLI accounts for work done outside the main
 * agent's own transcript: sub-agents (which run inside the CLI and never
 * appear in the parent stream) and helper models such as the haiku
 * auto-titler. `result.usage` covers the main agent alone.
 *
 * Verified 2026-08-27 on a captured episode with one synchronous sub-agent:
 * main agent 74,562 cache-read / 26,808 cache-write, sub-agent 28,079 /
 * 30,112, and `modelUsage` reported exactly the two summed — 102,641 /
 * 56,920.
 */
export interface ClaudeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

export interface ClaudeResultMessage {
  type: "result";
  subtype: "success" | "error";
  result?: string;
  error?: string;
  session_id?: string;
  /** Cumulative usage for the MAIN agent across every cycle of the episode. */
  usage?: ClaudeUsage;
  /** Per-model spend, including sub-agents and helper models. */
  modelUsage?: Record<string, ClaudeModelUsage>;
  num_turns?: number;
  total_cost_usd?: number;
}

/**
 * Complete-message envelope the CLI emits once per finished content block
 * (in addition to the SSE stream_events). `parent_tool_use_id` is null for
 * top-level content and set for sub-agent activity.
 */
export interface ClaudeAssistantEnvelope {
  type: "assistant";
  parent_tool_use_id?: string | null;
  message: {
    id?: string;
    role?: string;
    stop_reason?: string | null;
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    usage?: ClaudeUsage;
  };
}

/**
 * Emitted when the API reports rate-limit state for the account. Carries the
 * window and its reset, not a utilization percentage — the percentages the
 * Claude Code TUI shows come from `anthropic-ratelimit-unified-*` response
 * headers, which the CLI consumes in-process and does not forward here.
 */
export interface ClaudeRateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info?: {
    status?: string;
    resetsAt?: number;
    rateLimitType?: string;
    overageStatus?: string;
    overageDisabledReason?: string;
    isUsingOverage?: boolean;
  };
}

/** Tool results the CLI feeds back between cycles (top-level only). */
export interface ClaudeUserEnvelope {
  type: "user";
  parent_tool_use_id?: string | null;
  message: {
    role?: string;
    content?: Array<{
      type: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
  };
}

export interface ClaudeSystemMessage {
  type: "system";
  subtype: string;
  session_id?: string;
  tools?: unknown[];
}

export interface ClaudeControlRequest {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
  };
}

export type NdjsonMessage =
  | ClaudeStreamEventMessage
  | ClaudeResultMessage
  | ClaudeSystemMessage
  | ClaudeControlRequest
  | ClaudeAssistantEnvelope
  | ClaudeUserEnvelope
  | ClaudeRateLimitEvent;

// Claude API event types (inside stream_event wrapper)

export interface ClaudeApiEvent {
  type: string; // message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
  index?: number;
  message?: {
    id?: string;
    type?: string;
    role?: string;
    content?: unknown[];
    model?: string;
    usage?: ClaudeUsage;
  };
  content_block?: {
    type: string; // "text", "tool_use", "thinking"
    text?: string;
    id?: string;
    name?: string;
    input?: string;
  };
  delta?: {
    type?: string; // "text_delta", "input_json_delta", "thinking_delta", "signature_delta"
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: ClaudeUsage;
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// Content block tracking during stream processing

export interface TrackedContentBlock {
  type: "text" | "thinking";
  text: string;
  index: number; // Claude's content_block index (resets each cycle)
  cycle: number; // Which API call of the episode this block belongs to
  /** Position in output.content, or -1 while not materialized. */
  contentIndex: number;
  /** signature_delta received before any plaintext (encrypted thinking). */
  pendingSignature?: string;
}
