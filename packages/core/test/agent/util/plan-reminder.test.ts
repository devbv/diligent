// @summary Unit tests for plan-reminder helpers (parse / filter / build / scan)
import { describe, expect, test } from "bun:test";
import {
  buildPlanReminderMessage,
  findLatestPlanSteps,
  latestUserGoal,
  PLAN_TOOL_NAME,
  PlanReminder,
  type PlanStepLike,
  parsePlanSteps,
  remainingPlanSteps,
} from "../../../src/agent/util/plan-reminder";
import type { Message } from "../../../src/types";

const planOutput = (steps: PlanStepLike[]) => JSON.stringify({ title: "Plan", steps, hint: "..." });

function toolResult(toolName: string, output: string): Message {
  return { role: "tool_result", toolCallId: "tc", toolName, output, isError: false, timestamp: 1 };
}

describe("parsePlanSteps", () => {
  test("parses a valid plan output", () => {
    const steps: PlanStepLike[] = [
      { text: "a", status: "done" },
      { text: "b", status: "in_progress" },
    ];
    expect(parsePlanSteps(planOutput(steps))).toEqual(steps);
  });

  test("returns undefined for aborted / non-JSON / empty / bad shape", () => {
    expect(parsePlanSteps("[Aborted by user]")).toBeUndefined();
    expect(parsePlanSteps("not json")).toBeUndefined();
    expect(parsePlanSteps("{}")).toBeUndefined();
    expect(parsePlanSteps(JSON.stringify({ steps: "x" }))).toBeUndefined();
    expect(parsePlanSteps(JSON.stringify({ steps: [] }))).toBeUndefined();
  });

  test("filters out malformed step entries", () => {
    const out = JSON.stringify({
      steps: [
        { text: "ok", status: "pending" },
        { text: 5, status: "pending" },
        { text: "x", status: "bogus" },
      ],
    });
    expect(parsePlanSteps(out)).toEqual([{ text: "ok", status: "pending" }]);
  });
});

describe("remainingPlanSteps", () => {
  test("keeps only pending and in_progress", () => {
    const steps: PlanStepLike[] = [
      { text: "a", status: "done" },
      { text: "b", status: "pending" },
      { text: "c", status: "in_progress" },
      { text: "d", status: "cancelled" },
    ];
    expect(remainingPlanSteps(steps)).toEqual([
      { text: "b", status: "pending" },
      { text: "c", status: "in_progress" },
    ]);
  });
});

describe("buildPlanReminderMessage", () => {
  test("lists remaining steps, re-anchors the goal, and nudges plan maintenance", () => {
    const msg = buildPlanReminderMessage(
      [
        { text: "wire config", status: "in_progress" },
        { text: "add tests", status: "pending" },
      ],
      { goal: "build the feature", turnsSinceUpdate: 3 },
    );
    expect(msg).toContain("[Plan reminder]");
    expect(msg).toContain('You are still working on this task: "build the feature"');
    expect(msg).toContain("(in_progress) wire config");
    expect(msg).toContain("(pending) add tests");
    expect(msg).toContain("Keep the plan current");
    expect(msg).toContain("last plan update: 3 turns ago");
    expect(msg).toContain("request_user_input");
    expect(msg).toContain("do not tell the user the work is done");
  });

  test("omits the goal line and stale suffix when not provided", () => {
    const msg = buildPlanReminderMessage([{ text: "x", status: "pending" }]);
    expect(msg).toContain("[Plan reminder]");
    expect(msg).not.toContain("You are still working on this task");
    expect(msg).not.toContain("last plan update");
  });
});

describe("latestUserGoal", () => {
  test("returns the most recent user string message, truncated", () => {
    const messages: Message[] = [
      { role: "user", content: "first task", timestamp: 1 },
      toolResult(PLAN_TOOL_NAME, planOutput([{ text: "s", status: "pending" }])),
      { role: "user", content: "latest task", timestamp: 2 },
    ];
    expect(latestUserGoal(messages)).toBe("latest task");
    expect(latestUserGoal([{ role: "user", content: "x".repeat(300), timestamp: 1 }], 10)).toBe(`${"x".repeat(10)}…`);
  });

  test("returns undefined when there is no user string message", () => {
    expect(latestUserGoal([toolResult(PLAN_TOOL_NAME, "[Aborted by user]")])).toBeUndefined();
  });
});

describe("findLatestPlanSteps", () => {
  test("returns steps from the most recent parseable plan tool_result", () => {
    const messages: Message[] = [
      { role: "user", content: "hi", timestamp: 1 },
      toolResult(PLAN_TOOL_NAME, planOutput([{ text: "old", status: "pending" }])),
      toolResult("other", "irrelevant"),
      toolResult(PLAN_TOOL_NAME, planOutput([{ text: "new", status: "in_progress" }])),
    ];
    expect(findLatestPlanSteps(messages)).toEqual([{ text: "new", status: "in_progress" }]);
  });

  test("skips an aborted latest plan result and falls back to the earlier valid one", () => {
    const messages: Message[] = [
      toolResult(PLAN_TOOL_NAME, planOutput([{ text: "kept", status: "pending" }])),
      toolResult(PLAN_TOOL_NAME, "[Aborted by user]"),
    ];
    expect(findLatestPlanSteps(messages)).toEqual([{ text: "kept", status: "pending" }]);
  });

  test("returns undefined when there is no parseable plan tool_result", () => {
    expect(findLatestPlanSteps([toolResult(PLAN_TOOL_NAME, "[Aborted by user]")])).toBeUndefined();
    expect(findLatestPlanSteps([{ role: "user", content: "hi", timestamp: 1 }])).toBeUndefined();
  });
});

describe("PlanReminder", () => {
  const pendingPlan = () => planOutput([{ text: "step A", status: "pending" }]);

  test("fires only after intervalTurns pass without the plan being surfaced", () => {
    const reminder = new PlanReminder(2);
    // turn 1: the model creates the plan
    expect(reminder.reminderForTurn({ compactedThisTurn: false })).toBeNull();
    reminder.recordToolResult(PLAN_TOOL_NAME, pendingPlan(), false);
    reminder.endTurn();
    // turns 2 and 3: no plan update — still within cadence
    expect(reminder.reminderForTurn({ compactedThisTurn: false })).toBeNull();
    reminder.endTurn();
    expect(reminder.reminderForTurn({ compactedThisTurn: false })).toBeNull();
    reminder.endTurn();
    // turn 4: cadence elapsed → reminder fires with goal + step
    const msg = reminder.reminderForTurn({ compactedThisTurn: false, goal: "build X" });
    expect(msg).toContain("[Plan reminder]");
    expect(msg).toContain("(pending) step A");
    expect(msg).toContain("build X");
  });

  test("a plan update resets the cadence — no re-fire on the next turn", () => {
    const reminder = new PlanReminder(2);
    reminder.recordToolResult(PLAN_TOOL_NAME, pendingPlan(), false);
    reminder.endTurn();
    reminder.endTurn();
    reminder.endTurn();
    // the reminder fires at this turn's top...
    expect(reminder.reminderForTurn({ compactedThisTurn: false })).not.toBeNull();
    // ...and the model also re-touches the plan this turn
    reminder.recordToolResult(PLAN_TOOL_NAME, pendingPlan(), false);
    reminder.endTurn();
    // next turn: cadence was reset, so it stays quiet
    expect(reminder.reminderForTurn({ compactedThisTurn: false })).toBeNull();
  });

  test("never fires when disabled (interval 0)", () => {
    const reminder = new PlanReminder(0);
    reminder.recordToolResult(PLAN_TOOL_NAME, pendingPlan(), false);
    for (let i = 0; i < 5; i++) {
      expect(reminder.reminderForTurn({ compactedThisTurn: false })).toBeNull();
      reminder.endTurn();
    }
  });

  test("fires immediately after compaction, regardless of cadence", () => {
    const reminder = new PlanReminder(5, [{ text: "step A", status: "pending" }]);
    const msg = reminder.reminderForTurn({ compactedThisTurn: true });
    expect(msg).toContain("[Plan reminder]");
    expect(msg).toContain("(pending) step A");
  });

  test("does not fire without a plan, or when every step is resolved", () => {
    const noPlan = new PlanReminder(1);
    for (let i = 0; i < 3; i++) noPlan.endTurn();
    expect(noPlan.reminderForTurn({ compactedThisTurn: false })).toBeNull();

    const resolved = new PlanReminder(1, [
      { text: "a", status: "done" },
      { text: "b", status: "cancelled" },
    ]);
    resolved.endTurn();
    expect(resolved.reminderForTurn({ compactedThisTurn: false })).toBeNull();
    expect(resolved.reminderForTurn({ compactedThisTurn: true })).toBeNull();
  });

  test("exposes the latest plan (seed, then updates) for the loop to persist", () => {
    const reminder = new PlanReminder(3, [{ text: "seed", status: "pending" }]);
    expect(reminder.currentPlan).toEqual([{ text: "seed", status: "pending" }]);
    reminder.recordToolResult(PLAN_TOOL_NAME, planOutput([{ text: "updated", status: "in_progress" }]), false);
    expect(reminder.currentPlan).toEqual([{ text: "updated", status: "in_progress" }]);
    // non-plan and errored tool results leave the plan untouched
    reminder.recordToolResult("other", "whatever", false);
    reminder.recordToolResult(PLAN_TOOL_NAME, pendingPlan(), true);
    expect(reminder.currentPlan).toEqual([{ text: "updated", status: "in_progress" }]);
  });
});
