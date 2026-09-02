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

/**
 * Sub-agent lifecycle, emitted by the CLI as `system` envelopes.
 *
 * These arrive at TOP level — `parent_tool_use_id` is null — even for agents
 * nested several deep, verified on claude 2.1.231 at spawn depth 2. That is
 * what makes them usable: the sub-agents' own `assistant` envelopes are
 * tagged with `parent_tool_use_id` and stay internal to the CLI, but their
 * lifecycle is published here in the open.
 *
 * `description` means two different things by subtype. On `task_started` it
 * names the task; on `task_progress` it is the step running right now
 * ("Running …"). `src/task-tracker.ts` keeps them apart.
 */
export interface ClaudeTaskEvent {
  type: "system";
  subtype:
    | "task_started"
    | "task_progress"
    | "task_updated"
    | "task_notification"
    | string;
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  task_type?: string;
  /** Terminal status on `task_notification`. */
  status?: string;
  /** Where the CLI wrote the sub-agent's full report. */
  output_file?: string;
  /** Partial state change on `task_updated`. */
  patch?: { status?: string; end_time?: number };
  last_tool_name?: string;
  /**
   * The CLI's own "do not put this in a transcript" hint. Set on tasks it
   * considers plumbing; honoured for markers, not for tracking, because a
   * hidden sub-agent still holds the turn open.
   */
  skip_transcript?: boolean;
  /** The sub-agent's report, on `task_notification`. Live state, not content. */
  summary?: string;
  usage?: {
    total_tokens?: number;
    tool_uses?: number;
    duration_ms?: number;
  };
}

/** One sub-agent's state, as the host sees it. */
export interface TaskSnapshot {
  taskId: string;
  /** Names the task. Set at `task_started`, never overwritten by a step. */
  description: string;
  subagentType?: string;
  /**
   * The CLI's task kind — `local_agent` / `remote_agent` for a sub-agent.
   * Undefined on a CLI too old to send it, which is read as "agent" so the
   * tracker keeps working rather than going silent.
   */
  taskType?: string;
  /** The `Agent` tool call that launched this task; the join key a host needs. */
  toolUseId?: string;
  status: string;
  /** The step running right now, cleared when the task ends. */
  currentStep?: string;
  lastToolName?: string;
  toolUses?: number;
  totalTokens?: number;
  durationMs?: number;
  outputFile?: string;
  /** The sub-agent's own report, once it finishes. */
  summary?: string;
}

/** Every sub-agent seen this episode, in launch order. */
export interface TaskTrackerState {
  tasks: TaskSnapshot[];
  active: number;
  completed: number;
}

export interface ClaudeControlRequest {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    /** Claude Code 2.x: the assistant tool_use block this permission is for. */
    tool_use_id?: string;
  };
}

export type NdjsonMessage =
  | ClaudeStreamEventMessage
  | ClaudeResultMessage
  | ClaudeSystemMessage
  | ClaudeTaskEvent
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
