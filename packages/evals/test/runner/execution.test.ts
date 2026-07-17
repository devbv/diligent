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
    const result = await runEvalExecution({
      task: toolTask({ maxToolCalls: 0 }),
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "tool-limit-seed",
      streamFunction: sequenceStream([
        assistantMessage([{ type: "tool_call", id: "call-1", name: "touch_world", input: {} }], "tool_use"),
      ]),
    });

    expect(result.execution.termination).toBe("tool_call_limit");
    expect(result.worldSnapshot).toEqual({ executions: 0 });
  });

  test("classifies timeout independently of prompt rejection", async () => {
    const result = await runEvalExecution({
      task: toolTask({ timeoutMs: 10 }),
      profile: PROFILE,
      model: TEST_MODEL,
      seed: "timeout-seed",
      streamFunction: hangingStream(),
    });

    expect(result.execution.termination).toBe("timeout");
    expect(result.failure?.code).toBe("budget_exceeded.timeout");
    expect(result.execution.elapsedMs).toBeLessThan(250);
  });
});
