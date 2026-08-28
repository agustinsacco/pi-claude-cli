import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTaskTracker, isTaskSubtype } from "../src/task-tracker";
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

  it("survives a progress event that arrives before its start", () => {
    const t = createTaskTracker();
    t.apply({
      type: "system",
      subtype: "task_progress",
      task_id: "a1",
      description: "Running early",
    } as ClaudeTaskEvent);
    expect(t.snapshot().tasks[0].description).toBe("a1");

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
    expect(marker.length).toBeLessThan(200);
  });

  it("hands out copies, so a caller cannot mutate tracker state", () => {
    const t = createTaskTracker();
    t.apply(started("a1"));
    t.snapshot().tasks[0].description = "clobbered";
    expect(t.snapshot().tasks[0].description).toBe("task a1");
  });
});
