// @summary Tests runner-owned termination and tool budget enforcement

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runEvalExecution } from "../../src/runner/execution";
import type { EvalTask } from "../../src/task";
import { assistantMessage, hangingStream, sequenceStream, TEST_MODEL } from "../helpers/fake-stream";

const PROFILE = { provider: "anthropic", model: TEST_MODEL.modelId, effort: "medium" } as const;

function toolTask(overrides: Partial<EvalTask<{ executions: number }>["limits"]> = {}) {
  const task: EvalTask<{ executions: number }> = {
    id: "runner-tool-task",
    description: "Exercise runner limits",
    systemPrompt: [{ label: "test", content: "Use the tool." }],
    limits: { maxTurns: 2, maxToolCalls: 1, timeoutMs: 1_000, maxOutputTokens: 512, ...overrides },
    createWorld: () => ({ executions: 0 }),
    createTools: (world) => [
      {
        name: "touch_world",
        description: "Mutate the test world",
        parameters: z.object({}),
        async execute() {
          world.executions += 1;
          return { output: "done" };
        },
      },
    ],
    createUserMessage: () => ({ role: "user", content: "Run the tool", timestamp: Date.now() }),
    snapshotWorld: (world) => ({ ...world }),
    evaluate: () => ({ passed: true }),
  };
  return task;
}

describe("runEvalExecution", () => {
  test("classifies a turn limit even when core resolves after abort", async () => {
    const result = await runEvalExecution({
      task: toolTask({ maxTurns: 1 }),
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "turn-limit-seed",
      streamFunction: sequenceStream([
        assistantMessage([{ type: "tool_call", id: "call-1", name: "touch_world", input: {} }], "tool_use"),
      ]),
    });

    expect(result.passed).toBe(false);
    expect(result.execution.termination).toBe("turn_limit");
    expect(result.failure?.category).toBe("budget_exceeded");
  });

  test("prevents an over-budget tool from mutating the world", async () => {
    let evaluatorCalls = 0;
    const task = toolTask({ maxToolCalls: 0 });
    task.evaluate = () => {
      evaluatorCalls += 1;
      return { passed: true };
    };
    const result = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "tool-limit-seed",
      streamFunction: sequenceStream([
        assistantMessage([{ type: "tool_call", id: "call-1", name: "touch_world", input: {} }], "tool_use"),
      ]),
    });

    expect(result.execution.termination).toBe("tool_call_limit");
    expect(result.worldSnapshot).toEqual({ executions: 0 });
    expect(result.failure?.dimension).toBe("harness_terminal");
    expect(evaluatorCalls).toBe(0);
  });

  test("classifies timeout independently of prompt rejection", async () => {
    let evaluatorCalls = 0;
    const task = toolTask({ timeoutMs: 10 });
    task.evaluate = () => {
      evaluatorCalls += 1;
      return { passed: true };
    };
    const result = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "timeout-seed",
      streamFunction: hangingStream(),
    });

    expect(result.execution.termination).toBe("timeout");
    expect(result.failure?.code).toBe("budget_exceeded.timeout");
    expect(result.failure?.dimension).toBe("harness_terminal");
    expect(evaluatorCalls).toBe(0);
    expect(result.execution.elapsedMs).toBeLessThan(250);
  });

  test("classifies a runtime evaluator result missing its required dimension as evaluator_error", async () => {
    const task = toolTask();
    task.evaluate = () => ({ passed: false, code: "wrong_answer", message: "wrong" }) as never;
    const result = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "legacy-semantic-seed",
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
    });

    expect(result.failure).toMatchObject({
      category: "evaluator_error",
      dimension: "harness_terminal",
      code: "evaluator_error.missing_dimension",
    });
  });

  test("preserves explicit semantic failure dimensions", async () => {
    for (const dimension of ["behavior", "format_contract", "efficiency"] as const) {
      const task = toolTask();
      task.evaluate = () => ({ passed: false, dimension, code: "explicit", message: dimension }) as never;
      const result = await runEvalExecution({
        task,
        profile: PROFILE,
        model: TEST_MODEL,
        seed: `explicit-${dimension}`,
        streamFunction: sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
      });

      expect(result.failure?.dimension).toBe(dimension);
    }
  });

  test("preserves diagnostics from a failed semantic result without changing pass semantics", async () => {
    const task = toolTask();
    task.evaluate = () => ({
      passed: false,
      dimension: "behavior",
      code: "wrong_route",
      message: "wrong route",
      diagnostics: [{ dimension: "efficiency", code: "extra_search", message: "One extra safe search." }],
    });
    const result = await runEvalExecution({
      task,
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "failed-diagnostic-seed",
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
    });

    expect(result.passed).toBe(false);
    expect(result.failure?.dimension).toBe("behavior");
    expect(result.diagnostics).toEqual([
      { dimension: "efficiency", code: "extra_search", message: "One extra safe search." },
    ]);
  });
});
