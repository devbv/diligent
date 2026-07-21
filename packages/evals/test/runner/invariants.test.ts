// @summary Tests shared normalized-message and tool-pair structural invariants

import { describe, expect, test } from "bun:test";
import { checkStructuralInvariants } from "../../src/runner/invariants";
import type { EvalExecution } from "../../src/task";
import { assistantMessage } from "../helpers/fake-stream";

type EvalEvent = EvalExecution<unknown>["events"][number]["event"];

function runtimeStatusChange(status: "idle" | "busy"): EvalEvent {
  return { type: "status_change", status } as unknown as EvalEvent;
}

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
      {
        sequence: 4,
        relativeMs: 0,
        event: {
          type: "message_delta",
          itemId: "item-1",
          message: finalAssistant,
          delta: { type: "text_delta", delta: "done" },
        },
      },
      { sequence: 5, relativeMs: 0, event: { type: "message_end", itemId: "item-1", message: finalAssistant } },
      {
        sequence: 6,
        relativeMs: 0,
        event: { type: "turn_end", turnId: "turn-1", message: finalAssistant, toolResults: [] },
      },
      { sequence: 7, relativeMs: 0, event: { type: "agent_end", messages } },
    ],
    logs: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    turnCount: 1,
    toolCallCount: 0,
    world: {},
  };
}

function executionWithSequentialLifecycles(
  boundaryEvents: EvalExecution<unknown>["events"][number]["event"][] = [],
): EvalExecution<unknown> {
  const user = { role: "user", content: "hi", timestamp: 1 } as const;
  const assistant = assistantMessage([{ type: "text", text: "done" }]);
  const messages = [user, assistant];
  const lifecycle = (suffix: string): EvalExecution<unknown>["events"][number]["event"][] => [
    { type: "agent_start" },
    { type: "turn_start", turnId: `turn-${suffix}` },
    { type: "message_start", itemId: `item-${suffix}`, message: assistant },
    {
      type: "message_delta",
      itemId: `item-${suffix}`,
      message: assistant,
      delta: { type: "text_delta", delta: "done" },
    },
    { type: "message_end", itemId: `item-${suffix}`, message: assistant },
    { type: "turn_end", turnId: `turn-${suffix}`, message: assistant, toolResults: [] },
    { type: "agent_end", messages },
  ];
  const execution = executionWithMessages(messages);
  execution.events = [...lifecycle("1"), ...boundaryEvents, ...lifecycle("2")].map((event, index) => ({
    sequence: index + 1,
    relativeMs: 0,
    event,
  }));
  return execution;
}

describe("checkStructuralInvariants", () => {
  test("accepts a balanced completed conversation", () => {
    const user = { role: "user", content: "hi", timestamp: 1 } as const;
    const assistant = assistantMessage([{ type: "text", text: "done" }]);
    expect(checkStructuralInvariants(executionWithMessages([user, assistant]))).toEqual([]);
  });

  test("allows a missing final assistant only when the caller identifies an intentional cancellation", () => {
    const user = { role: "user", content: "choose", timestamp: 1 } as const;
    const input = executionWithMessages([user]);

    expect(checkStructuralInvariants(input).map((failure) => failure.code)).toContain(
      "core_contract.missing_final_assistant",
    );
    expect(
      checkStructuralInvariants(input, { allowMissingFinalAssistant: true }).map((failure) => failure.code),
    ).not.toContain("core_contract.missing_final_assistant");
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

    expect(failures.find((failure) => failure.code === "core_contract.orphaned_tool_result")).toMatchObject({
      dimension: "runtime_policy",
    });
  });

  test("rejects malformed normalized messages", () => {
    const malformed = { role: "assistant", content: "not-blocks" } as never;
    const failures = checkStructuralInvariants(executionWithMessages([malformed]));
    expect(failures.some((failure) => failure.code === "core_contract.malformed_message")).toBe(true);
  });

  test("accepts exact streamed text and rejects an adjacent final-message mirror mutation", () => {
    const user = { role: "user", content: "hi", timestamp: 1 } as const;
    const assistant = assistantMessage([{ type: "text", text: "streamed text" }]);
    const input = executionWithMessages([user, assistant]);
    const start = input.events.find((snapshot) => snapshot.event.type === "message_start")!;
    const end = input.events.find((snapshot) => snapshot.event.type === "message_end")!;
    const delta = input.events.find((snapshot) => snapshot.event.type === "message_delta")!;
    input.events.forEach((snapshot, index) => {
      snapshot.sequence = index + 1;
    });
    if (start.event.type === "message_start") start.event.message = assistant;
    if (delta.event.type === "message_delta") {
      delta.event.message = assistant;
      delta.event.delta = { type: "text_delta", delta: "streamed text" };
    }
    if (end.event.type === "message_end") end.event.message = assistant;

    expect(checkStructuralInvariants(input)).toEqual([]);

    const mutated = structuredClone(input);
    const mutatedEnd = mutated.events.find((snapshot) => snapshot.event.type === "message_end");
    if (mutatedEnd?.event.type === "message_end")
      mutatedEnd.event.message.content = [{ type: "text", text: "different final text" }];
    expect(checkStructuralInvariants(mutated)).toContainEqual(
      expect.objectContaining({
        code: "core_contract.streamed_text_mismatch",
        dimension: "runtime_policy",
      }),
    );
  });

  test("accepts mirrored tool image/error evidence and rejects adjacent surface mutations", () => {
    const user = { role: "user", content: "inspect", timestamp: 1 } as const;
    const call = assistantMessage([{ type: "tool_call", id: "image-1", name: "get_image", input: {} }], "tool_use");
    const image = {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/png" as const, data: "aW1hZ2U=" },
    };
    const result = {
      role: "tool_result" as const,
      toolCallId: "image-1",
      toolName: "get_image",
      output: "recoverable error",
      outputImages: [image],
      isError: true,
      timestamp: 2,
    };
    const final = assistantMessage([{ type: "text", text: "done" }]);
    const input = executionWithMessages([user, call, result, final]);
    input.events.splice(2, 0, {
      sequence: 3,
      relativeMs: 0,
      event: {
        type: "tool_start",
        itemId: "tool-item",
        toolCallId: "image-1",
        toolName: "get_image",
        input: {},
      },
    });
    input.events.splice(3, 0, {
      sequence: 4,
      relativeMs: 0,
      event: {
        type: "tool_end",
        itemId: "tool-item",
        toolCallId: "image-1",
        toolName: "get_image",
        output: result.output,
        outputImages: result.outputImages,
        isError: true,
      },
    });
    input.events.forEach((snapshot, index) => {
      snapshot.sequence = index + 1;
    });

    expect(checkStructuralInvariants(input)).toEqual([]);

    const missingImage = structuredClone(input);
    const missingImageEnd = missingImage.events.find((snapshot) => snapshot.event.type === "tool_end");
    if (missingImageEnd?.event.type === "tool_end") delete missingImageEnd.event.outputImages;
    expect(checkStructuralInvariants(missingImage)).toContainEqual(
      expect.objectContaining({ code: "core_contract.tool_result_image_mismatch" }),
    );

    const wrongError = structuredClone(input);
    const wrongErrorEnd = wrongError.events.find((snapshot) => snapshot.event.type === "tool_end");
    if (wrongErrorEnd?.event.type === "tool_end") wrongErrorEnd.event.isError = false;
    expect(checkStructuralInvariants(wrongError)).toContainEqual(
      expect.objectContaining({ code: "core_contract.tool_result_error_mismatch" }),
    );
  });

  test("accepts the rerun busy status between sequential agent lifecycles when enabled", () => {
    const input = executionWithSequentialLifecycles([runtimeStatusChange("busy")]);

    expect(checkStructuralInvariants(input, { allowMultipleAgentLifecycles: true })).toEqual([]);
  });

  test("rejects arbitrary events between sequential agent lifecycles", () => {
    const input = executionWithSequentialLifecycles([
      {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);

    expect(
      checkStructuralInvariants(input, { allowMultipleAgentLifecycles: true }).some(
        (failure) => failure.code === "core_contract.agent_event_outside_lifecycle",
      ),
    ).toBe(true);
  });

  test("rejects busy status outside a proven sequential lifecycle boundary", () => {
    const beforeFirst = executionWithSequentialLifecycles();
    beforeFirst.events.unshift({
      sequence: 0,
      relativeMs: 0,
      event: runtimeStatusChange("busy"),
    });
    const afterLast = executionWithSequentialLifecycles();
    afterLast.events.push({
      sequence: afterLast.events.length + 1,
      relativeMs: 0,
      event: runtimeStatusChange("busy"),
    });

    for (const input of [beforeFirst, afterLast]) {
      expect(
        checkStructuralInvariants(input, { allowMultipleAgentLifecycles: true }).some(
          (failure) => failure.code === "core_contract.agent_event_outside_lifecycle",
        ),
      ).toBe(true);
    }
  });

  test("rejects idle status between sequential agent lifecycles", () => {
    const input = executionWithSequentialLifecycles([runtimeStatusChange("idle")]);

    expect(
      checkStructuralInvariants(input, { allowMultipleAgentLifecycles: true }).some(
        (failure) => failure.code === "core_contract.agent_event_outside_lifecycle",
      ),
    ).toBe(true);
  });

  test("boundary busy status does not hide overlapping agent lifecycles", () => {
    const input = executionWithSequentialLifecycles([runtimeStatusChange("busy")]);
    const secondEnd = input.events.findLastIndex((snapshot) => snapshot.event.type === "agent_end");
    input.events.splice(secondEnd, 0, {
      sequence: 99,
      relativeMs: 0,
      event: { type: "agent_start" },
    });

    expect(
      checkStructuralInvariants(input, { allowMultipleAgentLifecycles: true }).some(
        (failure) => failure.code === "core_contract.agent_lifecycle_overlap",
      ),
    ).toBe(true);
  });

  test("boundary busy status does not hide unfinished nested lifecycle events", () => {
    const input = executionWithSequentialLifecycles([runtimeStatusChange("busy")]);
    const firstTurnEnd = input.events.findIndex((snapshot) => snapshot.event.type === "turn_end");
    input.events.splice(firstTurnEnd, 1);

    expect(
      checkStructuralInvariants(input, { allowMultipleAgentLifecycles: true }).some(
        (failure) => failure.code === "core_contract.agent_lifecycle_unbalanced",
      ),
    ).toBe(true);
  });

  test("keeps single-lifecycle mode strict for rerun boundary status", () => {
    const input = executionWithSequentialLifecycles([runtimeStatusChange("busy")]);
    const codes = checkStructuralInvariants(input).map((failure) => failure.code);

    expect(codes).toContain("core_contract.agent_start_count");
    expect(codes).toContain("core_contract.agent_end_count");
  });
});
