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
 *
 * TWO THINGS THIS CHANNEL IS NOT. Both were shipped as sub-agents once, and
 * both put rows in pidex that named work no agent ever did:
 *
 * - **Not every task is an agent.** `task_started` carries `task_type`, and
 *   the CLI auto-backgrounds a slow `Bash` into a `local_bash` task with the
 *   tool's own `description`. Captured 2026-08-28 on claude 2.1.231: a
 *   sub-agent's internal `find` surfaced as `[Claude Code · Task
 *   {"status":"started","description":"Search for local source checkout of
 *   pi-claude-cli"}]` — a fourth "agent" in a three-agent fan-out. Only
 *   `local_agent` and `remote_agent` are sub-agents.
 * - **Not every notification belongs to this episode.** `task_notification`
 *   carries no `description` and no `task_type` — only `task_id`. A task
 *   started in an EARLIER turn notifies in a later one, and a tracker that
 *   invents a placeholder from the id emits `{"status":"stopped",
 *   "description":"a8de7d982d824b56a"}`. An id this tracker never saw start
 *   is not this episode's business, so it is dropped.
 */

import type {
  ClaudeTaskEvent,
  TaskSnapshot,
  TaskTrackerState,
} from "./types.js";

/**
 * Marker argument previews are truncated to keep one row on one line.
 *
 * Raised from 120 when `task_id` joined the payload: at 120 the id pushed
 * `subagent_type` off the end, so a fan-out stopped saying WHICH kind of
 * agent it launched — the one fact the row exists to carry.
 */
export const ARGS_PREVIEW_LIMIT = 200;

/**
 * Per-field cap on the description, applied BEFORE the whole-payload cap.
 *
 * Ordering fields human-first is not enough on its own: one long description
 * eats the entire preview and takes `subagent_type` and `task_id` with it,
 * which is how a 300-character task name could cost a host the identity it
 * needs to collapse the row. Clip the one unbounded field instead, so the
 * small structural ones always survive.
 */
export const DESCRIPTION_PREVIEW_LIMIT = 120;

function clipDescription(value: string): string {
  return value.length > DESCRIPTION_PREVIEW_LIMIT
    ? `${value.slice(0, DESCRIPTION_PREVIEW_LIMIT)}…`
    : value;
}

/**
 * `task_type` values that mean "a sub-agent". Everything else the CLI tracks
 * as a task — `local_bash`, `local_shell`, `local_workflow`, `main_session` —
 * is plumbing this channel must not report as an agent.
 *
 * An event with NO `task_type` is treated as an agent: older CLIs omit the
 * field, and going silent on them would be a worse regression than the stray
 * row this filter exists to remove.
 */
const AGENT_TASK_TYPES = new Set(["local_agent", "remote_agent"]);

export function isAgentTaskType(taskType: unknown): boolean {
  return taskType === undefined || taskType === null
    ? true
    : typeof taskType === "string" && AGENT_TASK_TYPES.has(taskType);
}

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
  /**
   * Sub-agents that started this episode and have not reported yet.
   *
   * The provider waits on this before it tears the CLI down: the CLI emits
   * its turn `result` the moment the model stops talking, which for a
   * background fan-out is long before the agents finish.
   */
  pendingAgents(): number;
}

export function createTaskTracker(): TaskTracker {
  /** Insertion-ordered, so the snapshot reads in launch order. */
  const tasks = new Map<string, TaskSnapshot>();

  /**
   * Patch a task this tracker already knows. Returns undefined for an id it
   * never saw start — a task from an earlier episode, or one filtered out as
   * not-an-agent. Inventing a placeholder here is what named rows after raw
   * task ids; see the header.
   */
  function patch(
    id: string,
    changes: Partial<TaskSnapshot>,
  ): TaskSnapshot | undefined {
    const existing = tasks.get(id);
    if (!existing) return undefined;
    Object.assign(existing, changes);
    return existing;
  }

  return {
    apply(event: ClaudeTaskEvent): string | undefined {
      const id = event.task_id;
      if (!id) return undefined;

      switch (event.subtype) {
        case "task_started": {
          // Plumbing, not a sub-agent: an auto-backgrounded Bash arrives here
          // wearing the tool's own description. See the header.
          if (!isAgentTaskType(event.task_type)) return undefined;
          const task: TaskSnapshot = {
            taskId: id,
            description: event.description ?? id,
            subagentType: event.subagent_type,
            taskType: event.task_type,
            toolUseId: event.tool_use_id,
            status: "running",
          };
          tasks.set(id, task);
          // `skip_transcript` suppresses the ROW, never the tracking: a
          // hidden sub-agent still holds the turn open, and the provider
          // reads `pendingAgents()` to decide when the turn may end.
          if (event.skip_transcript === true) return undefined;
          return taskMarker({
            status: "started",
            description: clipDescription(task.description),
            subagent_type: task.subagentType,
            task_id: task.taskId,
          });
        }

        case "task_progress": {
          patch(id, {
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
          if (status) patch(id, { status });
          return undefined;
        }

        case "task_notification": {
          const task = patch(id, {
            status: event.status ?? "completed",
            outputFile: event.output_file,
            summary: event.summary,
            toolUses: event.usage?.tool_uses ?? tasks.get(id)?.toolUses,
            totalTokens:
              event.usage?.total_tokens ?? tasks.get(id)?.totalTokens,
            durationMs: event.usage?.duration_ms ?? tasks.get(id)?.durationMs,
            currentStep: undefined,
          });
          // Not ours: a task from an earlier episode, or one filtered out at
          // start. A notification carries no description, so the only row
          // this could produce would be named after a raw task id.
          if (!task) return undefined;
          // The sub-agent's full report reaches the model as the Task tool's
          // own result. Repeating it here would duplicate kilobytes into the
          // transcript, so the marker carries the shape of the work, not its
          // output.
          return taskMarker({
            status: task.status,
            description: clipDescription(task.description),
            task_id: task.taskId,
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

    pendingAgents(): number {
      let pending = 0;
      for (const task of tasks.values()) {
        if (task.status === "running") pending++;
      }
      return pending;
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
