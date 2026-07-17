// @summary Tests shared normalized-message and tool-pair structural invariants

import { describe, expect, test } from "bun:test";
import { checkStructuralInvariants } from "../../src/runner/invariants";
import type { EvalExecution } from "../../src/task";
import { assistantMessage } from "../helpers/fake-stream";

function executionWithMessages(messages: EvalExecution<unknown>["messages"]): EvalExecution<unknown> {
  const finalAssistant = assistantMessage([{ type: "text", text: "done" }]);
  return {
    taskId: "invariant-task",
    profile: { provider: "anthropic", model: "test-model", effort: "medium" },
    seed: "seed",
    startedAt: "2026-07-17T00:00:00.000Z",
    elapsedMs: 1,
    termination: "completed",
    messages,
    events: [
      { sequence: 1, relativeMs: 0, event: { type: "agent_start" } },
      { sequence: 2, relativeMs: 0, event: { type: "turn_start", turnId: "turn-1" } },
      { sequence: 3, relativeMs: 0, event: { type: "message_start", itemId: "item-1", message: finalAssistant } },
      { sequence: 4, relativeMs: 0, event: { type: "message_end", itemId: "item-1", message: finalAssistant } },
      {
        sequence: 5,
        relativeMs: 0,
        event: { type: "turn_end", turnId: "turn-1", message: finalAssistant, toolResults: [] },
      },
      { sequence: 6, relativeMs: 0, event: { type: "agent_end", messages } },
    ],
    logs: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    turnCount: 1,
    toolCallCount: 0,
    world: {},
  };
}

describe("checkStructuralInvariants", () => {
  test("accepts a balanced completed conversation", () => {
    const user = { role: "user", content: "hi", timestamp: 1 } as const;
    const assistant = assistantMessage([{ type: "text", text: "done" }]);
    expect(checkStructuralInvariants(executionWithMessages([user, assistant]))).toEqual([]);
  });

  test("rejects an orphaned tool result", () => {
    const user = { role: "user", content: "hi", timestamp: 1 } as const;
    const orphan = {
      role: "tool_result",
      toolCallId: "missing",
      toolName: "lookup",
      output: "nope",
      isError: false,
      timestamp: 2,
    } as const;
    const assistant = assistantMessage([{ type: "text", text: "done" }]);
    const failures = checkStructuralInvariants(executionWithMessages([user, orphan, assistant]));

    expect(failures.some((failure) => failure.code === "core_contract.orphaned_tool_result")).toBe(true);
  });

  test("rejects malformed normalized messages", () => {
    const malformed = { role: "assistant", content: "not-blocks" } as never;
    const failures = checkStructuralInvariants(executionWithMessages([malformed]));
    expect(failures.some((failure) => failure.code === "core_contract.malformed_message")).toBe(true);
  });
});
