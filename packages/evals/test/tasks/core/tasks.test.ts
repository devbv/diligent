// @summary End-to-end deterministic evaluator tests for all core eval tasks

import { describe, expect, test } from "bun:test";
import { runEvalExecution } from "../../../src/runner/execution";
import type { ParallelToolFragment } from "../../../src/tasks/core";
import { CORE_EVAL_TASKS } from "../../../src/tasks/core";
import { assistantMessage, sequenceStream, TEST_MODEL } from "../../helpers/fake-stream";

const PROFILE = { provider: "anthropic", model: TEST_MODEL.modelId, effort: "medium" } as const;

describe("core eval tasks", () => {
  test("registers every core task in one suite", () => {
    expect(CORE_EVAL_TASKS.map((task) => task.id)).toEqual([
      "direct-response",
      "single-tool",
      "tool-chain",
      "recover-tool-error",
      "structured-tool-args",
      "parallel-tools",
      "image-tool-result",
    ]);
  });

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

  test("image-tool-result requires two core image blocks and exact visual attribution", async () => {
    const task = CORE_EVAL_TASKS.find((candidate) => candidate.id === "image-tool-result")!;
    const world = task.createWorld("image-seed");
    const result = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "image-seed",
      streamFunction: sequenceStream([
        assistantMessage([{ type: "tool_call", id: "swatches-1", name: "get_swatch_pair", input: {} }], "tool_use"),
        assistantMessage([{ type: "text", text: world.expected }]),
      ]),
    });

    expect(result.passed).toBe(true);
    const toolEnd = result.execution.events.find(
      ({ event }) => event.type === "tool_end" && event.toolCallId === "swatches-1",
    )?.event;
    expect(toolEnd?.type === "tool_end" ? toolEnd.outputImages : undefined).toHaveLength(2);

    const withoutImages = structuredClone(result.execution);
    withoutImages.events = withoutImages.events.map((snapshot) => {
      if (snapshot.event.type !== "tool_end" || snapshot.event.toolCallId !== "swatches-1") return snapshot;
      const { outputImages: _omitted, ...event } = snapshot.event;
      return { ...snapshot, event };
    });
    expect(task.evaluate(withoutImages).passed).toBe(false);
  });

  test("structured-tool-args verifies nested schema values and the hidden receipt", async () => {
    const task = CORE_EVAL_TASKS.find((candidate) => candidate.id === "structured-tool-args")!;
    const world = task.createWorld("structured-seed");
    const result = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "structured-seed",
      streamFunction: sequenceStream([
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "job-1",
              name: "submit_job",
              input: {
                target: { recordId: world.recordId, revision: world.revision },
                operation: world.operation,
                options: { dryRun: world.dryRun, priority: world.priority, labels: world.labels },
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: `Receipt: ${world.receiptToken}` }]),
      ]),
    });

    expect(result.passed).toBe(true);
    expect(result.worldSnapshot).toMatchObject({ submitted: true });
  });

  test("structured-tool-args rejects a changed nested value", async () => {
    const task = CORE_EVAL_TASKS.find((candidate) => candidate.id === "structured-tool-args")!;
    const world = task.createWorld("structured-negative-seed");
    const result = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "structured-negative-seed",
      streamFunction: sequenceStream([
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "job-wrong",
              name: "submit_job",
              input: {
                target: { recordId: world.recordId, revision: world.revision },
                operation: world.operation,
                options: { dryRun: world.dryRun, priority: 1, labels: world.labels },
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "Done" }]),
      ]),
    });

    expect(result.failure?.code).toBe("task_semantic.structured_tool_args.wrong_values");
    expect(result.worldSnapshot).toMatchObject({ submitted: false });
  });

  test("parallel-tools requires one concurrent batch and all hidden fragments", async () => {
    const task = CORE_EVAL_TASKS.find((candidate) => candidate.id === "parallel-tools")!;
    const world = task.createWorld("parallel-seed");
    const calls = world.fragments.map((fragment: ParallelToolFragment, index: number) => ({
      type: "tool_call" as const,
      id: `fragment-${index + 1}`,
      name: "lookup_fragment",
      input: { fragmentId: fragment.fragmentId },
    }));
    const result = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "parallel-seed",
      streamFunction: sequenceStream([
        assistantMessage(calls, "tool_use"),
        assistantMessage([
          {
            type: "text",
            text: world.fragments.map((fragment: ParallelToolFragment) => fragment.code).join(" "),
          },
        ]),
      ]),
    });

    expect(result.passed).toBe(true);
    expect(result.worldSnapshot).toMatchObject({ maxConcurrentLookups: 3 });
    const firstToolEnd = result.execution.events.findIndex(({ event }) => event.type === "tool_end");
    const toolStartsBeforeEnd = result.execution.events
      .slice(0, firstToolEnd)
      .filter(({ event }) => event.type === "tool_start");
    expect(toolStartsBeforeEnd).toHaveLength(3);
  });

  test("parallel-tools rejects sequential lookup turns", async () => {
    const task = CORE_EVAL_TASKS.find((candidate) => candidate.id === "parallel-tools")!;
    const world = task.createWorld("parallel-negative-seed");
    const toolTurns = world.fragments.map((fragment: ParallelToolFragment, index: number) =>
      assistantMessage(
        [
          {
            type: "tool_call" as const,
            id: `sequential-${index + 1}`,
            name: "lookup_fragment",
            input: { fragmentId: fragment.fragmentId },
          },
        ],
        "tool_use",
      ),
    );
    const result = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "parallel-negative-seed",
      streamFunction: sequenceStream([
        ...toolTurns,
        assistantMessage([
          {
            type: "text",
            text: world.fragments.map((fragment: ParallelToolFragment) => fragment.code).join(" "),
          },
        ]),
      ]),
    });

    expect(result.failure?.code).toBe("task_semantic.parallel_tools.not_parallel");
    expect(result.worldSnapshot).toMatchObject({ maxConcurrentLookups: 1 });
  });
});
