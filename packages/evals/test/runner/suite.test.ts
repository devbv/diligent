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
    evaluate: () => (passed ? { passed: true } : { passed: false, code: "expected_failure", message: "failed" }),
  };
}

const METADATA = {
  suiteVersion: "core-v0",
  canonical: false,
  canonicalReason: "test",
  repository: "local/test",
  commitSha: "abc",
  ref: "local",
  runId: "local",
  runAttempt: "1",
  bunVersion: Bun.version,
};

const CANONICAL_MANIFEST = {
  taskIds: ["task-a", "task-b"],
  profiles: [
    { provider: "openai", model: "model-a", effort: "medium" },
    { provider: "anthropic", model: "model-b", effort: "medium" },
  ],
} as const;

describe("runEvalSuite", () => {
  test("continues after a failed execution and writes every selected result", async () => {
    const report = await runEvalSuite({
      tasks: [textTask("failing", false), textTask("passing", true)],
      profiles: [{ provider: "anthropic", model: TEST_MODEL.id, effort: "medium" }],
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

  test("rejects incomplete canonical selection", async () => {
    await expect(
      runEvalSuite({
        tasks: [textTask("only-one", true)],
        profiles: [{ provider: "anthropic", model: TEST_MODEL.id, effort: "medium" }],
        rootSeed: "root",
        metadata: { ...METADATA, canonical: true },
        canonicalManifest: CANONICAL_MANIFEST,
        resolveModel: () => TEST_MODEL,
        createStream: () => sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
      }),
    ).rejects.toThrow("exact canonical task and profile manifest");
  });

  test("rejects a same-sized but incorrect canonical selection", async () => {
    await expect(
      runEvalSuite({
        tasks: [textTask("task-a", true), textTask("wrong-task", true)],
        profiles: [...CANONICAL_MANIFEST.profiles],
        rootSeed: "root",
        metadata: { ...METADATA, canonical: true },
        canonicalManifest: CANONICAL_MANIFEST,
        resolveModel: () => TEST_MODEL,
        createStream: () => sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
      }),
    ).rejects.toThrow("exact canonical task and profile manifest");
  });

  test("requires a manifest for canonical execution", async () => {
    await expect(
      runEvalSuite({
        tasks: [textTask("task-a", true), textTask("task-b", true)],
        profiles: [...CANONICAL_MANIFEST.profiles],
        rootSeed: "root",
        metadata: { ...METADATA, canonical: true },
        resolveModel: () => TEST_MODEL,
        createStream: () => sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
      }),
    ).rejects.toThrow("requires a canonical manifest");
  });

  test("accepts the exact canonical manifest", async () => {
    const report = await runEvalSuite({
      tasks: [textTask("task-a", true), textTask("task-b", true)],
      profiles: [...CANONICAL_MANIFEST.profiles],
      rootSeed: "root",
      metadata: { ...METADATA, canonical: true },
      canonicalManifest: CANONICAL_MANIFEST,
      resolveModel: () => TEST_MODEL,
      createStream: () => sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
    });

    expect(report.canonical).toBe(true);
    expect(report.executions).toHaveLength(4);
  });
});
