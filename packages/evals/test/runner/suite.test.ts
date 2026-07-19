// @summary Tests sequential suite completeness and shared task seeds across profiles

import { describe, expect, test } from "bun:test";
import { runEvalSuite } from "../../src/runner/suite";
import type { EvalTask } from "../../src/task";
import { assistantMessage, sequenceStream, TEST_MODEL } from "../helpers/fake-stream";

function textTask(id: string, passed: boolean): EvalTask<{ expected: string }> {
  return {
    id,
    description: id,
    systemPrompt: [],
    limits: { maxTurns: 1, maxToolCalls: 0, timeoutMs: 1_000, maxOutputTokens: 512 },
    createWorld: (seed) => ({ expected: `${id}:${seed}` }),
    createTools: () => [],
    createUserMessage: () => ({ role: "user", content: "respond", timestamp: Date.now() }),
    snapshotWorld: (world) => ({ ...world }),
    evaluate: () =>
      passed
        ? { passed: true }
        : { passed: false, code: "expected_failure", message: "failed", dimension: "semantic_goal" },
  };
}

const METADATA = {
  suiteVersion: "core-v0",
  repository: "local/test",
  commitSha: "abc",
  ref: "local",
  runId: "local",
  runAttempt: "1",
  bunVersion: Bun.version,
};

describe("runEvalSuite", () => {
  test("uses an injected execution adapter", async () => {
    let calls = 0;
    const task = textTask("adapter", true);
    const execute = async (input: Parameters<typeof import("../../src/runner/execution").runEvalExecution>[0]) => {
      calls += 1;
      return {
        passed: true,
        failures: [],
        worldSnapshot: { adapter: true },
        execution: {
          taskId: input.task.id,
          profile: input.profile,
          seed: input.seed,
          startedAt: new Date(0).toISOString(),
          elapsedMs: 0,
          termination: "completed",
          messages: [],
          events: [],
          logs: [],
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          turnCount: 0,
          toolCallCount: 0,
          world: { expected: "adapter" },
        },
      };
    };
    const report = await runEvalSuite({
      tasks: [task],
      profiles: [{ provider: "anthropic", model: TEST_MODEL.modelId, effort: "medium" }],
      rootSeed: "root",
      metadata: METADATA,
      resolveModel: () => TEST_MODEL,
      createStream: () => sequenceStream([assistantMessage([{ type: "text", text: "unused" }])]),
      execute: execute as never,
    });
    expect(calls).toBe(1);
    expect(report.executions[0]?.world).toEqual({ adapter: true });
  });
  test("continues after a failed execution and writes every selected result", async () => {
    const report = await runEvalSuite({
      tasks: [textTask("failing", false), textTask("passing", true)],
      profiles: [{ provider: "anthropic", model: TEST_MODEL.modelId, effort: "medium" }],
      rootSeed: "root",
      metadata: METADATA,
      resolveModel: () => TEST_MODEL,
      createStream: () => sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
    });

    expect(report.passed).toBe(false);
    expect(report.executions.map((execution) => execution.taskId)).toEqual(["failing", "passing"]);
    expect(report.executions[1]?.passed).toBe(true);
  });

  test("uses the same task seed for independently executed provider profiles", async () => {
    const report = await runEvalSuite({
      tasks: [textTask("shared-seed", true)],
      profiles: [
        { provider: "anthropic", model: "test-a", effort: "medium" },
        { provider: "anthropic", model: "test-b", effort: "medium" },
      ],
      rootSeed: "root",
      metadata: METADATA,
      resolveModel: () => TEST_MODEL,
      createStream: () => sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
    });

    expect(report.executions).toHaveLength(2);
    expect(report.executions[0]?.taskSeed).toBe(report.executions[1]?.taskSeed);
    expect(report.executions[0]?.world).toEqual(report.executions[1]?.world);
  });

  test("keeps schema v1 and pass semantics while reporting non-empty diagnostics additively", async () => {
    const task = textTask("diagnostic-pass", true);
    task.evaluate = () =>
      ({
        passed: true,
        diagnostics: [{ dimension: "efficiency", code: "extra_safe_read", message: "One bounded read recovered." }],
      }) as never;
    const report = await runEvalSuite({
      tasks: [task],
      profiles: [{ provider: "anthropic", model: TEST_MODEL.modelId, effort: "medium" }],
      rootSeed: "root",
      metadata: METADATA,
      resolveModel: () => TEST_MODEL,
      createStream: () => sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.passed).toBe(true);
    expect(report.executions[0]).toMatchObject({
      passed: true,
      failures: [],
      diagnostics: [{ dimension: "efficiency", code: "extra_safe_read", message: "One bounded read recovered." }],
    });
    expect(report.executions[0]).not.toHaveProperty("failure");
    expect(report.executions[0]).toHaveProperty("failures");
  });

  test("rejects duplicate task IDs", async () => {
    await expect(
      runEvalSuite({
        tasks: [textTask("duplicate", true), textTask("duplicate", true)],
        profiles: [{ provider: "anthropic", model: TEST_MODEL.modelId, effort: "medium" }],
        rootSeed: "root",
        metadata: METADATA,
        resolveModel: () => TEST_MODEL,
        createStream: () => sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
      }),
    ).rejects.toThrow("Duplicate eval task ID");
  });
});
