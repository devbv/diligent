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

  test("direct-response assigns exact final bytes to the format contract", async () => {
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

    const wrongFinal = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "direct-seed",
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: `${world.nonce}-wrong` }])]),
    });
    expect(wrongFinal.failure).toMatchObject({
      code: "task_semantic.direct_response.final_text_mismatch",
      dimension: "format_contract",
    });

    const extraWhitespace = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "direct-seed",
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: `${world.nonce}\n` }])]),
    });
    expect(extraWhitespace.failure).toMatchObject({
      code: "task_semantic.direct_response.final_text_mismatch",
      dimension: "format_contract",
    });

    const missingDelta = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "direct-seed",
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: world.nonce }])], {
        emitTextDeltas: false,
      }),
    });
    expect(missingDelta.failure).toMatchObject({
      code: "core_contract.streamed_text_mismatch",
      dimension: "runtime_policy",
    });
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

    const wrongArgument = structuredClone(result.execution);
    const start = wrongArgument.events.find((snapshot) => snapshot.event.type === "tool_start");
    if (start?.event.type === "tool_start") start.event.input = { recordId: "wrong-record" };
    expect(task.evaluate(wrongArgument)).toMatchObject({
      passed: false,
      code: "single_tool.wrong_record_id",
      dimension: "behavior",
    });

    const missingReceipt = structuredClone(result.execution);
    const final = missingReceipt.messages.at(-1);
    if (final?.role === "assistant") final.content = [{ type: "text", text: "Done" }];
    expect(task.evaluate(missingReceipt)).toMatchObject({
      passed: false,
      code: "single_tool.missing_code",
      dimension: "semantic_goal",
    });

    const missingCall = structuredClone(result.execution);
    missingCall.events = missingCall.events.filter((snapshot) => snapshot.event.type !== "tool_start");
    expect(task.evaluate(missingCall)).toMatchObject({
      passed: false,
      code: "single_tool.wrong_trace",
      dimension: "behavior",
    });

    const wrongTool = structuredClone(result.execution);
    const wrongToolStart = wrongTool.events.find((snapshot) => snapshot.event.type === "tool_start");
    if (wrongToolStart?.event.type === "tool_start") wrongToolStart.event.toolName = "undeclared_lookup";
    expect(task.evaluate(wrongTool)).toMatchObject({
      passed: false,
      code: "single_tool.wrong_trace",
      dimension: "runtime_policy",
    });
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

    const wrongOrder = structuredClone(result.execution);
    const starts = wrongOrder.events.filter((snapshot) => snapshot.event.type === "tool_start");
    if (starts[0]?.event.type === "tool_start" && starts[1]?.event.type === "tool_start") {
      const firstName = starts[0].event.toolName;
      starts[0].event.toolName = starts[1].event.toolName;
      starts[1].event.toolName = firstName;
    }
    expect(task.evaluate(wrongOrder)).toMatchObject({
      passed: false,
      code: "tool_chain.wrong_order",
      dimension: "behavior",
    });
  });

  test("recover-tool-error keeps recovery decisions semantic and normalization deterministic", async () => {
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

    const mirroredWithoutErrorFlag = structuredClone(result.execution);
    for (const snapshot of mirroredWithoutErrorFlag.events) {
      if (snapshot.event.type === "tool_end" && snapshot.event.toolCallId === "update-1")
        snapshot.event.isError = false;
    }
    for (const message of mirroredWithoutErrorFlag.messages) {
      if (message.role === "tool_result" && message.toolCallId === "update-1") message.isError = false;
    }
    expect(task.evaluate(mirroredWithoutErrorFlag)).toEqual({ passed: true });

    const wrongRetry = structuredClone(result.execution);
    const retry = wrongRetry.events.find(
      (snapshot) => snapshot.event.type === "tool_start" && snapshot.event.toolCallId === "update-2",
    );
    if (retry?.event.type === "tool_start")
      retry.event.input = {
        recordId: world.recordId,
        revision: world.staleRevision,
        value: world.desiredValue,
      };
    expect(task.evaluate(wrongRetry)).toMatchObject({
      passed: false,
      code: "recover_tool_error.wrong_retry",
      dimension: "behavior",
    });
  });

  test("image-tool-result keeps transport plumbing out of live classification", async () => {
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
    expect(task.evaluate(withoutImages)).toEqual({ passed: true });

    const wrongAnswer = structuredClone(result.execution);
    const final = wrongAnswer.messages.at(-1);
    if (final?.role === "assistant") final.content = [{ type: "text", text: "A=GREEN; B=GREEN" }];
    expect(task.evaluate(wrongAnswer)).toMatchObject({
      passed: false,
      code: "image_tool_result.answer",
      dimension: "semantic_goal",
    });

    const wrongEnvelope = structuredClone(result.execution);
    const envelopeFinal = wrongEnvelope.messages.at(-1);
    if (envelopeFinal?.role === "assistant") envelopeFinal.content = [{ type: "text", text: `${world.expected}\n` }];
    expect(task.evaluate(wrongEnvelope)).toMatchObject({
      passed: false,
      code: "image_tool_result.format",
      dimension: "format_contract",
    });
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
    expect(result.failure?.dimension).toBe("behavior");
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
    expect(result.failure?.dimension).toBe("behavior");
    expect(result.worldSnapshot).toMatchObject({ maxConcurrentLookups: 1 });

    result.execution.world.maxConcurrentLookups = result.execution.world.fragments.length;
    expect(task.evaluate(result.execution)).toMatchObject({
      passed: false,
      code: "parallel_tools.not_parallel",
      dimension: "behavior",
    });
  });
});
