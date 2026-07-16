// @summary Runtime plan-reminder parsing, cadence, restore, and injection tests

import { describe, expect, test } from "bun:test";
import type { Message, ToolCallBlock, ToolResultMessage } from "@diligent/core/types";
import {
  buildPlanReminderMessage,
  createPlanReminderHook,
  findLatestPlanSteps,
  latestUserGoal,
  parsePlanSteps,
  remainingPlanSteps,
} from "../../src/agent/plan-reminder-hook";

const planOutput = (status: "pending" | "in_progress" | "done" | "cancelled" = "pending") =>
  JSON.stringify({ steps: [{ text: "step A", status }] });
const toolCall: ToolCallBlock = { type: "tool_call", id: "tc", name: "plan", input: {} };
const result = (output = planOutput(), isError = false): ToolResultMessage => ({
  role: "tool_result",
  toolCallId: "tc",
  toolName: "plan",
  output,
  isError,
  timestamp: Date.now(),
});
const user = (content: string): Message => ({ role: "user", content, timestamp: Date.now() });

describe("plan reminder helpers", () => {
  test("parses valid steps and rejects malformed output", () => {
    expect(parsePlanSteps(planOutput())).toEqual([{ text: "step A", status: "pending" }]);
    expect(parsePlanSteps("not-json")).toBeUndefined();
    expect(parsePlanSteps(JSON.stringify({ steps: [] }))).toBeUndefined();
  });

  test("finds the latest successful plan and filters resolved steps", () => {
    const messages: Message[] = [result(planOutput("pending")), result("[Aborted by user]", true)];
    expect(findLatestPlanSteps(messages)).toEqual([{ text: "step A", status: "pending" }]);
    expect(
      remainingPlanSteps([
        { text: "A", status: "done" },
        { text: "B", status: "in_progress" },
      ]),
    ).toEqual([{ text: "B", status: "in_progress" }]);
  });

  test("builds the established model-facing text", () => {
    const content = buildPlanReminderMessage([{ text: "A", status: "pending" }], { goal: "ship" });
    expect(content).toContain("<system-reminder>");
    expect(content).toContain("Goal: ship");
    expect(content).toContain("- (pending) A");
  });

  test("captures the latest user goal", () => {
    expect(latestUserGoal([user("earlier"), user("real goal")])).toBe("real goal");
  });
});

describe("createPlanReminderHook", () => {
  test("restores plan state and fires after the configured cadence", () => {
    const hook = createPlanReminderHook({ intervalTurns: 2 });
    hook.restore?.({ messages: [result()] });
    hook.onPromptStart?.({ messages: [user("ship it")] });

    expect(hook.beforeTurn?.({ messages: [], turnId: "t1", compactedThisTurn: false })).toBeUndefined();
    hook.afterTurn?.({ turnId: "t1", message: {} as never, toolResults: [] });
    expect(hook.beforeTurn?.({ messages: [], turnId: "t2", compactedThisTurn: false })).toBeUndefined();
    hook.afterTurn?.({ turnId: "t2", message: {} as never, toolResults: [] });
    const injections = hook.beforeTurn?.({ messages: [], turnId: "t3", compactedThisTurn: false });
    expect(injections?.[0]?.source).toBe("plan-reminder");
    expect(injections?.[0]?.content).toContain("Goal: ship it");
  });

  test("fires immediately after compaction and resets cadence on plan updates", () => {
    const hook = createPlanReminderHook({ intervalTurns: 5 });
    hook.restore?.({ messages: [result()] });
    expect(hook.beforeTurn?.({ messages: [], turnId: "t1", compactedThisTurn: true })).toHaveLength(1);
    hook.onToolResult?.({ turnId: "t1", toolCall, result: result(planOutput("in_progress")) });
    hook.afterTurn?.({ turnId: "t1", message: {} as never, toolResults: [] });
    expect(hook.beforeTurn?.({ messages: [], turnId: "t2", compactedThisTurn: false })).toBeUndefined();
  });

  test("does not inject when disabled, absent, or resolved", () => {
    const disabled = createPlanReminderHook({ intervalTurns: 0 });
    disabled.restore?.({ messages: [result()] });
    expect(disabled.beforeTurn?.({ messages: [], turnId: "t", compactedThisTurn: true })).toBeUndefined();

    const resolved = createPlanReminderHook({ intervalTurns: 1 });
    resolved.restore?.({ messages: [result(planOutput("done"))] });
    expect(resolved.beforeTurn?.({ messages: [], turnId: "t", compactedThisTurn: true })).toBeUndefined();
  });
});
