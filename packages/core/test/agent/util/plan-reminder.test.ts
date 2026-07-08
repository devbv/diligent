// @summary Unit tests for plan-reminder helpers (parse / filter / build / scan)
import { describe, expect, test } from "bun:test";
import {
  buildPlanReminderMessage,
  findLatestPlanSteps,
  PLAN_TOOL_NAME,
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
  test("lists each remaining step with status and the do-not-end instruction", () => {
    const msg = buildPlanReminderMessage([
      { text: "wire config", status: "in_progress" },
      { text: "add tests", status: "pending" },
    ]);
    expect(msg).toContain("do not end your turn");
    expect(msg).toContain("(in_progress) wire config");
    expect(msg).toContain("(pending) add tests");
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
