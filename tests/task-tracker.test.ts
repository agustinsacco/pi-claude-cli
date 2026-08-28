import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARGS_PREVIEW_LIMIT,
  createTaskTracker,
  isTaskSubtype,
} from "../src/task-tracker";
import type { ClaudeTaskEvent } from "../src/types";

/**
 * Captured from a real `claude -p` run on 2.1.231 with a NESTED fan-out: the
 * top-level agent spawned a general-purpose sub-agent, which spawned an
 * Explore sub-agent of its own. Every envelope here arrived at top level
 * (`parent_tool_use_id` null), which is the property #23's fix depends on.
 */
const CAPTURE: ClaudeTaskEvent[] = readFileSync(
  join(__dirname, "fixtures", "subagent-task-events.ndjson"),
  "utf-8",
)
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const MARKER = /^\[Claude Code · ([^\s\]]+)(?:\s+([\s\S]*))?\]$/;

function started(id: string, over: Partial<ClaudeTaskEvent> = {}) {
  return {
    type: "system",
    subtype: "task_started",
    task_id: id,
    description: `task ${id}`,
    subagent_type: "general-purpose",
    ...over,
  } as ClaudeTaskEvent;
}

describe("isTaskSubtype", () => {
  it("accepts the four sub-agent lifecycle subtypes", () => {
    for (const s of [
      "task_started",
      "task_progress",
      "task_updated",
      "task_notification",
    ]) {
      expect(isTaskSubtype(s)).toBe(true);
    }
  });

  it("rejects the other system subtypes the CLI sends", () => {
    // These share the `system` type and must not reach the tracker.
    for (const s of [
      "init",
      "status",
      "task_summary",
      "background_tasks_changed",
      "post_turn_summary",
      "thinking_tokens",
    ]) {
      expect(isTaskSubtype(s)).toBe(false);
    }
  });

  it("rejects non-strings", () => {
    expect(isTaskSubtype(undefined)).toBe(false);
    expect(isTaskSubtype(null)).toBe(false);
    expect(isTaskSubtype(7)).toBe(false);
  });
});

describe("createTaskTracker", () => {
  it("emits a marker on start and on finish, and nothing in between", () => {
    const t = createTaskTracker();

    expect(t.apply(started("a1"))).toBeTruthy();
    expect(
      t.apply({
        type: "system",
        subtype: "task_progress",
        task_id: "a1",
        description: "Running something",
        usage: { tool_uses: 3, total_tokens: 900, duration_ms: 120 },
        last_tool_name: "Bash",
      } as ClaudeTaskEvent),
    ).toBeUndefined();
    expect(
      t.apply({
        type: "system",
        subtype: "task_updated",
        task_id: "a1",
        patch: { status: "completed" },
      } as ClaudeTaskEvent),
    ).toBeUndefined();
    expect(
      t.apply({
        type: "system",
        subtype: "task_notification",
        task_id: "a1",
        status: "completed",
        usage: { tool_uses: 4, total_tokens: 1000, duration_ms: 200 },
      } as ClaudeTaskEvent),
    ).toBeTruthy();
  });

  it("emits markers that satisfy the front-end wire contract", () => {
    const t = createTaskTracker();
    const markers = CAPTURE.map((e) => t.apply(e)).filter(Boolean) as string[];

    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) {
      const match = MARKER.exec(m);
      expect(match, `marker did not parse: ${m}`).not.toBeNull();
      expect(match![1]).toBe("Task");
      // One row, one line. A newline would break the marker into prose.
      expect(m).not.toContain("\n");
    }
  });

  it("keeps a nested sub-agent, because its events arrive at top level", () => {
    const t = createTaskTracker();
    for (const e of CAPTURE) t.apply(e);

    const snap = t.snapshot();
    expect(snap.tasks).toHaveLength(2);
    expect(snap.tasks.map((x) => x.subagentType)).toEqual([
      "general-purpose",
      "Explore",
    ]);
    expect(snap.active).toBe(0);
    expect(snap.completed).toBe(2);
  });

  it("reports the real capture's totals", () => {
    const t = createTaskTracker();
    for (const e of CAPTURE) t.apply(e);

    const nested = t.snapshot().tasks.find((x) => x.subagentType === "Explore");
    expect(nested).toMatchObject({
      status: "completed",
      toolUses: 2,
      totalTokens: 16219,
      durationMs: 11091,
    });
  });

  it("does not let a progress step overwrite the task's own description", () => {
    // `description` means the task on task_started and the CURRENT STEP on
    // task_progress. Conflating them renames the task on every tool call.
    const t = createTaskTracker();
    t.apply(started("a1", { description: "Angle A line-by-line scan" }));
    t.apply({
      type: "system",
      subtype: "task_progress",
      task_id: "a1",
      description: "Running grep for callers",
    } as ClaudeTaskEvent);

    const task = t.snapshot().tasks[0];
    expect(task.description).toBe("Angle A line-by-line scan");
    expect(task.currentStep).toBe("Running grep for callers");
  });

  it("clears the current step once the task ends", () => {
    const t = createTaskTracker();
    t.apply(started("a1"));
    t.apply({
      type: "system",
      subtype: "task_progress",
      task_id: "a1",
      description: "Running grep",
    } as ClaudeTaskEvent);
    t.apply({
      type: "system",
      subtype: "task_notification",
      task_id: "a1",
      status: "completed",
    } as ClaudeTaskEvent);

    expect(t.snapshot().tasks[0].currentStep).toBeUndefined();
  });

  it("counts a running fan-out as active until each agent reports", () => {
    const t = createTaskTracker();
    for (const id of ["a", "b", "c"]) t.apply(started(id));
    expect(t.snapshot()).toMatchObject({ active: 3, completed: 0 });

    t.apply({
      type: "system",
      subtype: "task_notification",
      task_id: "b",
      status: "completed",
    } as ClaudeTaskEvent);
    expect(t.snapshot()).toMatchObject({ active: 2, completed: 1 });
  });

  it("carries a non-completed terminal status through", () => {
    const t = createTaskTracker();
    t.apply(started("a1"));
    t.apply({
      type: "system",
      subtype: "task_notification",
      task_id: "a1",
      status: "failed",
    } as ClaudeTaskEvent);

    expect(t.snapshot().tasks[0].status).toBe("failed");
    expect(t.snapshot().active).toBe(0);
  });

  it("keeps usage from progress when the notification omits it", () => {
    const t = createTaskTracker();
    t.apply(started("a1"));
    t.apply({
      type: "system",
      subtype: "task_progress",
      task_id: "a1",
      usage: { tool_uses: 9, total_tokens: 4242, duration_ms: 777 },
    } as ClaudeTaskEvent);
    t.apply({
      type: "system",
      subtype: "task_notification",
      task_id: "a1",
      status: "completed",
    } as ClaudeTaskEvent);

    expect(t.snapshot().tasks[0]).toMatchObject({
      toolUses: 9,
      totalTokens: 4242,
      durationMs: 777,
    });
  });

  it("ignores events with no task_id and unknown subtypes", () => {
    const t = createTaskTracker();
    expect(
      t.apply({ type: "system", subtype: "task_started" } as ClaudeTaskEvent),
    ).toBeUndefined();
    expect(
      t.apply({
        type: "system",
        subtype: "task_summary",
        task_id: "a1",
      } as ClaudeTaskEvent),
    ).toBeUndefined();
    expect(t.snapshot().tasks).toHaveLength(0);
  });

  it("ignores a progress event that arrives before its start, then names it", () => {
    // The tracker used to invent a placeholder named after the raw task id.
    // That is what produced rows like `{"status":"stopped",
    // "description":"a8de7d982d824b56a"}` for agents started in an earlier
    // turn — a task this episode never saw start is not its business.
    const t = createTaskTracker();
    t.apply({
      type: "system",
      subtype: "task_progress",
      task_id: "a1",
      description: "Running early",
    } as ClaudeTaskEvent);
    expect(t.snapshot().tasks).toHaveLength(0);

    // The start still names it properly when it does arrive.
    t.apply(started("a1", { description: "the real name" }));
    expect(t.snapshot().tasks[0].description).toBe("the real name");
    expect(t.snapshot().tasks).toHaveLength(1);
  });

  it("tolerates a task_updated with no patch", () => {
    const t = createTaskTracker();
    t.apply(started("a1"));
    t.apply({
      type: "system",
      subtype: "task_updated",
      task_id: "a1",
    } as ClaudeTaskEvent);
    expect(t.snapshot().tasks[0].status).toBe("running");
  });

  it("truncates a long description rather than wrapping the row", () => {
    const t = createTaskTracker();
    const marker = t.apply(started("a1", { description: "x".repeat(400) }))!;
    expect(marker).toMatch(MARKER);
    expect(marker).toContain("…");
    // Bounded by the preview cap plus `[Claude Code · Task …]`, not by a
    // number that has to be re-guessed every time the payload grows.
    expect(marker.length).toBeLessThan(ARGS_PREVIEW_LIMIT + 40);
  });

  it("keeps the agent's TYPE readable when the cap truncates", () => {
    // Regression: adding `task_id` to the payload once pushed
    // `subagent_type` past the cap, so a fan-out stopped saying which kind
    // of agent it launched. Human-readable fields come first for this reason.
    const t = createTaskTracker();
    const marker = t.apply(
      started("a1", { description: "y".repeat(300), subagent_type: "Explore" }),
    )!;
    expect(marker).toContain("Explore");
  });

  it("hands out copies, so a caller cannot mutate tracker state", () => {
    const t = createTaskTracker();
    t.apply(started("a1"));
    t.snapshot().tasks[0].description = "clobbered";
    expect(t.snapshot().tasks[0].description).toBe("task a1");
  });
});

/**
 * The task feed is not a sub-agent feed. `task_started` carries `task_type`,
 * and the CLI auto-backgrounds a slow `Bash` into a `local_bash` task wearing
 * the tool's own description — which reached a real pidex transcript as a
 * fourth "agent" in a three-agent fan-out (captured 2026-08-28, claude
 * 2.1.231).
 */
describe("only sub-agents count as sub-agents", () => {
  const nonAgent = (id: string, taskType: string) =>
    ({
      type: "system",
      subtype: "task_started",
      task_id: id,
      task_type: taskType,
      description: "Search for local source checkout of pi-claude-cli",
    }) as ClaudeTaskEvent;

  it("keeps local_agent and remote_agent", () => {
    for (const taskType of ["local_agent", "remote_agent"]) {
      const t = createTaskTracker();
      expect(t.apply(started("a1", { task_type: taskType }))).toBeDefined();
      expect(t.snapshot().tasks).toHaveLength(1);
    }
  });

  it("drops an auto-backgrounded Bash, marker and snapshot alike", () => {
    const t = createTaskTracker();
    expect(t.apply(nonAgent("b1", "local_bash"))).toBeUndefined();
    expect(t.snapshot().tasks).toHaveLength(0);
    expect(t.pendingAgents()).toBe(0);
  });

  it("drops the other task kinds the CLI tracks", () => {
    for (const taskType of ["local_shell", "local_workflow", "main_session"]) {
      const t = createTaskTracker();
      expect(t.apply(nonAgent("x1", taskType))).toBeUndefined();
      expect(t.snapshot().tasks).toHaveLength(0);
    }
  });

  it("drops the completion of a task it never admitted", () => {
    // The pair is what produced the phantom row: a started AND a completed
    // marker for a shell command, indistinguishable from an agent.
    const t = createTaskTracker();
    t.apply(nonAgent("b1", "local_bash"));
    expect(
      t.apply({
        type: "system",
        subtype: "task_notification",
        task_id: "b1",
        status: "completed",
      } as ClaudeTaskEvent),
    ).toBeUndefined();
  });

  it("still tracks a task from a CLI too old to send task_type", () => {
    // Going silent on an older CLI would be a worse regression than the
    // stray row the filter exists to remove.
    const t = createTaskTracker();
    expect(t.apply(started("a1"))).toBeDefined();
    expect(t.snapshot().tasks).toHaveLength(1);
  });
});

describe("notifications from another episode", () => {
  it("emits no marker for a task id this tracker never saw start", () => {
    // A turn that only replays late notifications produced rows named after
    // raw task ids — `{"status":"stopped","description":"a8de7d982d824b56a"}`
    // — because the tracker is per-episode and a notification carries no
    // description of its own.
    const t = createTaskTracker();
    expect(
      t.apply({
        type: "system",
        subtype: "task_notification",
        task_id: "a8de7d982d824b56a",
        status: "stopped",
      } as ClaudeTaskEvent),
    ).toBeUndefined();
    expect(t.snapshot().tasks).toHaveLength(0);
  });
});

describe("pendingAgents", () => {
  it("counts agents that started and have not reported", () => {
    const t = createTaskTracker();
    t.apply(started("a1"));
    t.apply(started("a2"));
    expect(t.pendingAgents()).toBe(2);

    t.apply({
      type: "system",
      subtype: "task_notification",
      task_id: "a1",
      status: "completed",
    } as ClaudeTaskEvent);
    expect(t.pendingAgents()).toBe(1);
  });

  it("counts a non-completed terminal status as reported", () => {
    const t = createTaskTracker();
    t.apply(started("a1"));
    t.apply({
      type: "system",
      subtype: "task_notification",
      task_id: "a1",
      status: "failed",
    } as ClaudeTaskEvent);
    expect(t.pendingAgents()).toBe(0);
  });

  it("is zero for a tracker that saw no agents at all", () => {
    expect(createTaskTracker().pendingAgents()).toBe(0);
  });

  it("carries the sub-agent's own report on the snapshot", () => {
    const t = createTaskTracker();
    t.apply(started("a1"));
    t.apply({
      type: "system",
      subtype: "task_notification",
      task_id: "a1",
      status: "completed",
      summary: "probe-ok",
    } as ClaudeTaskEvent);
    expect(t.snapshot().tasks[0].summary).toBe("probe-ok");
  });
});

describe("skip_transcript", () => {
  it("suppresses the row but still holds the turn open", () => {
    const t = createTaskTracker();
    expect(
      t.apply(started("a1", { skip_transcript: true } as any)),
    ).toBeUndefined();
    expect(t.pendingAgents()).toBe(1);
  });
});
