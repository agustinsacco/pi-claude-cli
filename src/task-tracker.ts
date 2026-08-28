/**
 * Sub-agent (Task) visibility.
 *
 * The CLI runs sub-agents inside its own process. Their stream envelopes carry
 * `parent_tool_use_id` and are deliberately not forwarded — they are the CLI's
 * internal loop, and forwarding hundreds of nested tool calls would bury the
 * turn. But dropping them left a host with nothing at all: a single
 * `[Claude Code · Task {…}]` marker and then silence for as long as the
 * fan-out ran. One pidex turn sat blank for eight minutes behind 14 nested
 * agents and was killed as hung (issue #23).
 *
 * The CLI already publishes a purpose-built feed for exactly this, and the
 * provider was not reading it. `system` envelopes with a `task_*` subtype
 * arrive at TOP level (`parent_tool_use_id` is null) even for agents nested
 * several deep, verified on claude 2.1.231 at spawn depth 2. They are low
 * volume and carry description, sub-agent type, tool count, tokens and
 * duration.
 *
 * Two channels, split by durability:
 *
 * - **Lifecycle goes in the turn** as marker text. `task_started` and the
 *   terminal `task_notification` are durable facts about what the turn did,
 *   and belong in the transcript beside the CLI's other tool markers. Two
 *   lines per sub-agent, so a 14-agent fan-out costs 28.
 * - **Progress goes out of band**, like `rate_limit_event` before it.
 *   `task_progress` fires once per sub-agent tool call — ~700 times in the
 *   incident above — which is live state, not transcript. It must never be
 *   folded into turn content.
 *
 * What this deliberately does NOT do: build a tree. No task envelope names its
 * parent task, so a nested agent is indistinguishable from a top-level one
 * here. The list is flat, and honestly so.
 */

import type {
  ClaudeTaskEvent,
  TaskSnapshot,
  TaskTrackerState,
} from "./types.js";

/** Marker argument previews are truncated to keep one row on one line. */
const ARGS_PREVIEW_LIMIT = 120;

/**
 * Build a `[Claude Code · Task …]` marker.
 *
 * WIRE CONTRACT — the same shape `event-bridge.ts` emits for CLI-side tool
 * executions, and front-ends parse it with
 * `/^\[Claude Code · ([^\s\]]+)(?:\s+([\s\S]*))?\]$/`. The tool name must stay
 * space-free; everything else rides in the argument JSON, which is truncated
 * here and must never be parsed as JSON by a consumer.
 */
function taskMarker(args: Record<string, unknown>): string {
  let preview = "";
  try {
    const json = JSON.stringify(args);
    preview =
      json === "{}"
        ? ""
        : ` ${json.slice(0, ARGS_PREVIEW_LIMIT)}${json.length > ARGS_PREVIEW_LIMIT ? "…" : ""}`;
  } catch {
    /* unserializable — the marker still names the tool */
  }
  return `[Claude Code · Task${preview}]`;
}

export interface TaskTracker {
  /**
   * Fold one `task_*` envelope in. Returns a marker string when the event is a
   * durable lifecycle transition (start, finish) and nothing when it is live
   * progress. Unknown subtypes and events without a `task_id` are ignored.
   */
  apply(event: ClaudeTaskEvent): string | undefined;
  /** Current state of every sub-agent seen this episode. */
  snapshot(): TaskTrackerState;
}

export function createTaskTracker(): TaskTracker {
  /** Insertion-ordered, so the snapshot reads in launch order. */
  const tasks = new Map<string, TaskSnapshot>();

  function upsert(id: string, patch: Partial<TaskSnapshot>): TaskSnapshot {
    const existing = tasks.get(id);
    const next: TaskSnapshot = existing ?? {
      taskId: id,
      // A progress event can arrive before the start it belongs to if the CLI
      // reorders; the id is a truthful placeholder until the start names it.
      description: id,
      status: "running",
    };
    Object.assign(next, patch);
    tasks.set(id, next);
    return next;
  }

  return {
    apply(event: ClaudeTaskEvent): string | undefined {
      const id = event.task_id;
      if (!id) return undefined;

      switch (event.subtype) {
        case "task_started": {
          const task = upsert(id, {
            description: event.description ?? id,
            subagentType: event.subagent_type,
            status: "running",
          });
          return taskMarker({
            status: "started",
            description: task.description,
            subagent_type: task.subagentType,
          });
        }

        case "task_progress": {
          upsert(id, {
            // `description` on a progress event is the CURRENT step ("Running
            // …"), not the task's own description. Keep them apart: the task
            // name was set at start and must not be overwritten by a step.
            currentStep: event.description,
            subagentType: event.subagent_type ?? tasks.get(id)?.subagentType,
            lastToolName: event.last_tool_name,
            toolUses: event.usage?.tool_uses,
            totalTokens: event.usage?.total_tokens,
            durationMs: event.usage?.duration_ms,
          });
          return undefined;
        }

        case "task_updated": {
          const status = event.patch?.status;
          upsert(id, status ? { status } : {});
          return undefined;
        }

        case "task_notification": {
          const task = upsert(id, {
            status: event.status ?? "completed",
            outputFile: event.output_file,
            toolUses: event.usage?.tool_uses ?? tasks.get(id)?.toolUses,
            totalTokens:
              event.usage?.total_tokens ?? tasks.get(id)?.totalTokens,
            durationMs: event.usage?.duration_ms ?? tasks.get(id)?.durationMs,
            currentStep: undefined,
          });
          // The sub-agent's full report reaches the model as the Task tool's
          // own result. Repeating it here would duplicate kilobytes into the
          // transcript, so the marker carries the shape of the work, not its
          // output.
          return taskMarker({
            status: task.status,
            description: task.description,
            tool_uses: task.toolUses,
            total_tokens: task.totalTokens,
            duration_ms: task.durationMs,
          });
        }

        default:
          return undefined;
      }
    },

    snapshot(): TaskTrackerState {
      const list = [...tasks.values()].map((t) => ({ ...t }));
      return {
        tasks: list,
        active: list.filter((t) => t.status === "running").length,
        completed: list.filter((t) => t.status !== "running").length,
      };
    },
  };
}

/** The `system` subtypes this module handles. */
const TASK_SUBTYPES = new Set([
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
]);

/**
 * Whether a `system` envelope's subtype is sub-agent lifecycle.
 *
 * `system` also carries init/status/summary envelopes that have nothing to do
 * with sub-agents, so the provider narrows before handing anything over.
 */
export function isTaskSubtype(subtype: unknown): boolean {
  return typeof subtype === "string" && TASK_SUBTYPES.has(subtype);
}
