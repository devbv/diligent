// @summary Deterministic end-to-end test for the in-process runtime eval adapter and cleanup

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { runRuntimeEvalExecution } from "../../src/runner/runtime-execution";
import type { RuntimeEvalTask } from "../../src/runtime-task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  type RuntimeFixtureWorld,
  writeFixture,
} from "../../src/tasks/runtime/helpers";
import { assistantMessage, hangingStream, sequenceStream } from "../helpers/fake-stream";

describe("runRuntimeEvalExecution", () => {
  test("runs through app-server/RPC, persists evidence, and removes the exact temporary root", async () => {
    let fixtureRoot = "";
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-smoke",
      description: "smoke",
      fixtureVersion: "smoke-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 1, maxToolCalls: 0, timeoutMs: 5_000 },
      toolPolicy: { allowedCapabilities: [], allowedCommands: [] },
      async setup(seed, root) {
        fixtureRoot = root;
        return { root, seed, expected: "done", protectedPaths: [], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "reply" }],
      snapshotWorld: async () => ({ smoke: true }),
      evaluate: () => ({ passed: true }),
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-4-6", effort: "medium" },
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
    });

    expect(result.passed).toBe(true);
    expect(result.execution.turns).toHaveLength(1);
    expect(result.execution.session.lines.length).toBeGreaterThan(2);
    expect(JSON.stringify({ ...result.execution, world: null })).not.toContain(fixtureRoot);
    expect(existsSync(fixtureRoot)).toBe(false);
  });

  test("interrupts and fails a task when the runner-owned timeout expires", async () => {
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-timeout",
      description: "timeout",
      fixtureVersion: "timeout-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 1, maxToolCalls: 0, timeoutMs: 30 },
      toolPolicy: { allowedCapabilities: [], allowedCommands: [] },
      async setup(seed, root) {
        return { root, seed, expected: "", protectedPaths: [], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "wait" }],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-4-6", effort: "medium" },
      streamFunction: hangingStream(),
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.code === "budget_exceeded.timeout")).toBe(true);
    expect(result.execution.termination).toBe("timeout");
  });

  test("stops before an over-budget provider turn reaches the underlying stream", async () => {
    let providerCalls = 0;
    const messages = sequenceStream([
      assistantMessage(
        [{ type: "tool_call", id: "read-1", name: "read", input: { file_path: "value.txt" } }],
        "tool_use",
      ),
    ]);
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-turn-limit",
      description: "turn limit",
      fixtureVersion: "turn-limit-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 1, maxToolCalls: 2, timeoutMs: 5_000 },
      toolPolicy: { allowedCapabilities: ["read"], allowedCommands: [] },
      async setup(seed, root) {
        await writeFixture(root, { "value.txt": "value\n" });
        return { root, seed, expected: "", protectedPaths: ["value.txt"], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "read" }],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-4-6", effort: "medium" },
      streamFunction: (...args) => {
        providerCalls += 1;
        return messages(...args);
      },
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.code === "budget_exceeded.turn_limit")).toBe(true);
    expect(providerCalls).toBe(1);
  });
});
