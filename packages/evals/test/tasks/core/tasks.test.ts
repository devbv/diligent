// @summary End-to-end deterministic evaluator tests for all core eval tasks

import { describe, expect, test } from "bun:test";
import { runEvalExecution } from "../../../src/runner/execution";
import { CORE_EVAL_TASKS } from "../../../src/tasks/core";
import { assistantMessage, sequenceStream, TEST_MODEL } from "../../helpers/fake-stream";

const PROFILE = { provider: "anthropic", model: TEST_MODEL.id, effort: "medium" } as const;

describe("core eval tasks", () => {
  test("direct-response requires matching streamed and final text", async () => {
    const task = CORE_EVAL_TASKS.find((candidate) => candidate.id === "direct-response")!;
    const world = task.createWorld("direct-seed");
    const result = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "direct-seed",
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: world.nonce }])]),
    });
    expect(result.passed).toBe(true);

    const missingDelta = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "direct-seed",
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: world.nonce }])], {
        emitTextDeltas: false,
      }),
    });
    expect(missingDelta.failure?.code).toBe("core_contract.message_end_without_start");
  });

  test("single-tool verifies the exact lookup and hidden code", async () => {
    const task = CORE_EVAL_TASKS.find((candidate) => candidate.id === "single-tool")!;
    const world = task.createWorld("single-seed");
    const result = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "single-seed",
      streamFunction: sequenceStream([
        assistantMessage(
          [{ type: "tool_call", id: "lookup-1", name: "lookup_record", input: { recordId: world.recordId } }],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: world.verificationCode }]),
      ]),
    });
    expect(result.passed).toBe(true);
  });

  test("tool-chain verifies ordered dependent values and final state", async () => {
    const task = CORE_EVAL_TASKS.find((candidate) => candidate.id === "tool-chain")!;
    const world = task.createWorld("chain-seed");
    const result = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "chain-seed",
      streamFunction: sequenceStream([
        assistantMessage(
          [{ type: "tool_call", id: "order-1", name: "get_order", input: { orderId: world.orderId } }],
          "tool_use",
        ),
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "quote-1",
              name: "create_refund_quote",
              input: { orderToken: world.orderToken, amount: world.refundAmount },
            },
          ],
          "tool_use",
        ),
        assistantMessage(
          [{ type: "tool_call", id: "submit-1", name: "submit_refund", input: { quoteToken: world.quoteToken } }],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "Refund submitted." }]),
      ]),
    });
    expect(result.passed).toBe(true);
    expect(result.worldSnapshot).toMatchObject({ submittedRefund: { orderId: world.orderId } });
  });

  test("recover-tool-error requires an error result and corrected revision", async () => {
    const task = CORE_EVAL_TASKS.find((candidate) => candidate.id === "recover-tool-error")!;
    const world = task.createWorld("recovery-seed");
    const result = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "recovery-seed",
      streamFunction: sequenceStream([
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "update-1",
              name: "update_record",
              input: { recordId: world.recordId, revision: world.staleRevision, value: world.desiredValue },
            },
          ],
          "tool_use",
        ),
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "update-2",
              name: "update_record",
              input: { recordId: world.recordId, revision: world.currentRevision, value: world.desiredValue },
            },
          ],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "Record updated." }]),
      ]),
    });
    expect(result.passed).toBe(true);
    expect(result.worldSnapshot).toMatchObject({ value: world.desiredValue, updateAttempts: 2 });
    expect(
      result.execution.events.some(
        (snapshot) =>
          snapshot.event.type === "tool_end" && snapshot.event.toolCallId === "update-1" && snapshot.event.isError,
      ),
    ).toBe(true);
  });
});
