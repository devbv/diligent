// @summary Synthetic evaluator regressions for exact post-write baseline verification semantics

import { describe, expect, test } from "bun:test";
import type { Message } from "@diligent/core/message-contract";
import type { RuntimeEvalExecution, RuntimeToolTrace } from "../../../src/runtime-task";
import type { EvalSemanticResult } from "../../../src/task";
import { planToExecuteTask } from "../../../src/tasks/runtime/plan-to-execute";
import { projectFixTask } from "../../../src/tasks/runtime/project-fix";

describe("baseline verification semantics", () => {
  test("project-fix requires an exact passing bun test after the final successful write", () => {
    expect(projectFixTask.fixtureVersion).toBe("project-fix-v1");
    assertVerificationRegressions(projectFixExecution, (execution) => projectFixTask.evaluate(execution));
  });

  test("plan-to-execute requires an exact passing bun test after the final successful write", () => {
    expect(planToExecuteTask.fixtureVersion).toBe("plan-to-execute-v3");
    assertVerificationRegressions(planToExecuteExecution, (execution) => planToExecuteTask.evaluate(execution));
  });
});

function assertVerificationRegressions<T>(
  createExecution: () => RuntimeEvalExecution<T>,
  evaluate: (execution: RuntimeEvalExecution<T>) => EvalSemanticResult,
): void {
  expect(evaluate(createExecution())).toEqual({ passed: true });

  const cases: Array<[string, (execution: RuntimeEvalExecution<T>) => void]> = [
    ["non-exact command", (execution) => (testTrace(execution).input = { command: "bun test --watch" })],
    ["runtime-error outcome", (execution) => (testTrace(execution).outcome = "runtime_error")],
    ["missing output evidence", (execution) => delete testTrace(execution).output],
    [
      "missing exit metadata",
      (execution) => (testTrace(execution).output = { output: "tests passed without exit evidence" }),
    ],
    ["nonzero exit", (execution) => (testTrace(execution).output = { output: "failed", metadata: { exitCode: 1 } })],
    [
      "test before final write",
      (execution) => {
        writeTrace(execution).sequence = 3;
        testTrace(execution).sequence = 2;
      },
    ],
    [
      "write after last passing test",
      (execution) =>
        execution.toolCalls.push({
          sequence: 4,
          toolCallId: "write-after-test",
          name: "edit",
          capability: "write",
          input: { file_path: "$WORKSPACE/src/value.ts" },
          outcome: "success",
        }),
    ],
  ];

  for (const [name, mutate] of cases) {
    const execution = createExecution();
    mutate(execution);
    expect(evaluate(execution), name).toMatchObject({ passed: false, dimension: "behavior" });
  }
}

function projectFixExecution() {
  const world = {
    root: "$WORKSPACE",
    seed: "seed",
    operand: 3,
    expected: "fixed source",
    expectedHash: "fixed-hash",
    protectedPaths: [],
    allowedChanges: ["src/value.ts"],
  };
  const execution = baseExecution(world, [turn("repair", [assistant("Implemented and verified.")])]);
  execution.toolCalls = verificationTraces();
  execution.workspace.initial.entries = [file("src/value.ts", "initial-hash")];
  execution.workspace.final.entries = [file("src/value.ts", world.expectedHash)];
  return execution;
}

function planToExecuteExecution() {
  const world = {
    root: "$WORKSPACE",
    seed: "seed",
    token: "CONTRACT_seed",
    multiplier: 3,
    offset: 5,
    diagnosisPath: "spec/private-contract.txt",
    expected: "fixed source",
    expectedHash: "fixed-hash",
    protectedPaths: [],
    allowedChanges: ["src/value.ts"],
  };
  const plan = turn("plan", [assistant(`Contract ${world.token}: value * ${world.multiplier} + ${world.offset}`)]);
  plan.coreEvents = [
    {
      sequence: 1,
      relativeMs: 0,
      event: {
        type: "tool_start",
        itemId: "plan-read-item",
        toolCallId: "read-source",
        toolName: "read",
        input: { file_path: "$WORKSPACE/spec/private-contract.txt" },
      },
    },
  ];
  const execution = baseExecution(world, [plan, turn("execute", [assistant("Implemented and verified.")])]);
  execution.session.lines.push({ type: "mode_change", mode: "default" });
  execution.toolCalls = verificationTraces();
  execution.toolCalls[0]!.input = { file_path: "$WORKSPACE/spec/private-contract.txt" };
  execution.workspace.final.entries = [file("src/value.ts", world.expectedHash)];
  return execution;
}

function verificationTraces(): RuntimeToolTrace[] {
  return [
    {
      sequence: 1,
      toolCallId: "read-source",
      name: "read",
      capability: "read",
      input: { file_path: "$WORKSPACE/src/value.ts" },
      outcome: "success",
    },
    {
      sequence: 2,
      toolCallId: "write-source",
      name: "edit",
      capability: "write",
      input: { file_path: "$WORKSPACE/src/value.ts" },
      outcome: "success",
    },
    {
      sequence: 3,
      toolCallId: "test-project",
      name: "bash",
      capability: "execute",
      input: { command: "bun test" },
      outcome: "success",
      output: { output: "1 pass", metadata: { exitCode: 0 } },
    },
  ];
}

function testTrace<T>(execution: RuntimeEvalExecution<T>): RuntimeToolTrace {
  const trace = execution.toolCalls.find((call) => call.name === "bash");
  if (!trace) throw new Error("Missing synthetic test trace.");
  return trace;
}

function writeTrace<T>(execution: RuntimeEvalExecution<T>): RuntimeToolTrace {
  const trace = execution.toolCalls.find((call) => call.capability === "write");
  if (!trace) throw new Error("Missing synthetic write trace.");
  return trace;
}

function baseExecution<T>(world: T, turns: RuntimeEvalExecution<T>["turns"]): RuntimeEvalExecution<T> {
  return {
    taskId: "baseline-verification",
    profile: { provider: "anthropic", model: "test-model", effort: "medium" },
    seed: "seed",
    startedAt: new Date(0).toISOString(),
    elapsedMs: 1,
    termination: "completed",
    turns,
    compactions: [],
    threadCwd: "$WORKSPACE",
    advertisedTools: [],
    threadReads: [],
    protocolActions: [],
    providerCalls: [],
    toolCalls: [],
    toolOutputFiles: [],
    approvals: [],
    userInputRequests: [],
    logs: [],
    session: { threadId: "thread-1", lines: [{ type: "session", id: "thread-1" }] },
    childSessions: [],
    workspace: { initial: { entries: [] }, final: { entries: [] } },
    runtimeState: { initial: [], final: [], diff: [] },
    verifier: { argv: ["bun", "test"], exitCode: 0, elapsedMs: 1, stdout: "", stderr: "", timedOut: false },
    world,
  };
}

function turn(clientPrompt: string, messages: Message[]): RuntimeEvalExecution<unknown>["turns"][number] {
  return {
    index: 0,
    threadId: "thread-1",
    clientPrompt,
    startedAt: new Date(0).toISOString(),
    elapsedMs: 1,
    termination: "completed",
    coreEvents: [],
    runtimeEvents: [],
    notifications: [],
    messages,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

function assistant(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: {
      provider: "anthropic",
      modelId: "test-model",
    },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: 0,
  };
}

function file(path: string, sha256: string) {
  return { path, kind: "file" as const, size: 1, sha256 };
}
