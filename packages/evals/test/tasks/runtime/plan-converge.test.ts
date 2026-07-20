// @summary Strict contract and evaluator tests for the plan-converge runtime eval

import { describe, expect, test } from "bun:test";
import type { RuntimeEvalExecution, RuntimeToolTrace } from "../../../src/runtime-task";
import { type PlanConvergeWorld, planConvergeTask } from "../../../src/tasks/runtime/plan-converge";

const API_PATH = "facts/api.txt";
const UI_PATH = "facts/ui.txt";
const THREAD_ID = "thread-1";

describe("plan-converge runtime eval", () => {
  test("budgets one exact paired Anthropic path recovery without expanding turns", () => {
    expect(planConvergeTask.fixtureVersion).toBe("plan-converge-v3");
    expect(planConvergeTask.limits).toMatchObject({
      maxTurns: 6,
      maxToolCalls: 5,
      maxUserInputRequests: 1,
    });
  });

  test("accepts the direct OpenAI path and exact paired Anthropic relative-read recovery", () => {
    expect(planConvergeTask.evaluate(directExecution())).toEqual({ passed: true });
    expect(planConvergeTask.evaluate(recoveryExecution())).toEqual({ passed: true });
  });

  test("rejects malformed, extra, general, misordered, or misattributed recovery", () => {
    const cases: Array<[string, (execution: RuntimeEvalExecution<PlanConvergeWorld>) => void]> = [
      ["wrong provider", (execution) => (execution.profile.provider = "openai")],
      ["wrong recovery name", (execution) => (execution.toolCalls[0]!.name = "request_user_input")],
      ["wrong recovery capability", (execution) => (execution.toolCalls[0]!.capability = "user_input")],
      ["successful recovery", (execution) => (execution.toolCalls[0]!.outcome = "success")],
      ["policy recovery", (execution) => (execution.toolCalls[0]!.outcome = "policy_rejection")],
      ["absolute failed path", (execution) => (execution.toolCalls[0]!.input = { file_path: absolute(API_PATH) })],
      ["wrong failed path", (execution) => (execution.toolCalls[0]!.input = { file_path: "facts/other.txt" })],
      ["extra failed input", (execution) => (execution.toolCalls[0]!.input = { file_path: API_PATH, limit: 1 })],
      ["wrong error", (execution) => (execution.toolCalls[0]!.error = "different")],
      [
        "wrong output error",
        (execution) => ((execution.toolCalls[0]!.output as { output: string }).output = "different"),
      ],
      [
        "missing error metadata",
        (execution) => delete (execution.toolCalls[0]!.output as { metadata?: unknown }).metadata,
      ],
      [
        "false error metadata",
        (execution) => ((execution.toolCalls[0]!.output as { metadata: { error: boolean } }).metadata.error = false),
      ],
      [
        "general runtime error metadata",
        (execution) =>
          ((execution.toolCalls[0]!.output as { metadata: Record<string, unknown> }).metadata.code = "general"),
      ],
      ["swapped recovery order", (execution) => swap(execution.toolCalls, 0, 1)],
      ["recovery after success", (execution) => swap(execution.toolCalls, 1, 2)],
      ["non-contiguous recovery", (execution) => (execution.toolCalls[1]!.sequence = 3)],
      ["missing recovery actor", (execution) => delete execution.toolCalls[0]!.threadId],
      ["wrong recovery actor", (execution) => (execution.toolCalls[1]!.threadId = "other-thread")],
      ["child recovery actor", (execution) => (execution.toolCalls[0]!.childThreadId = "child-thread")],
      ["relative successful read", (execution) => (execution.toolCalls[2]!.input = { file_path: API_PATH })],
      ["failed absolute read", (execution) => (execution.toolCalls[2]!.outcome = "runtime_error")],
      ["wrong absolute read output", (execution) => (execution.toolCalls[2]!.output = "different")],
      [
        "extra recovery",
        (execution) =>
          execution.toolCalls.splice(2, 0, {
            ...structuredClone(execution.toolCalls[0]!),
            sequence: 3,
            toolCallId: "extra-recovery",
          }),
      ],
      [
        "general runtime error",
        (execution) => {
          const extra = failedRelativeRead(3, "facts/other.txt");
          extra.error = "general runtime failure";
          extra.output = { output: "general runtime failure", metadata: { error: true } };
          execution.toolCalls.splice(2, 0, extra);
        },
      ],
    ];

    for (const [name, mutate] of cases) {
      const execution = recoveryExecution();
      mutate(execution);
      expect(planConvergeTask.evaluate(execution).passed, name).toBe(false);
    }
  });

  test("requires a successful exact bounded question and its scripted answer before planning", () => {
    const cases: Array<[string, (execution: RuntimeEvalExecution<PlanConvergeWorld>) => void]> = [
      ["failed question", (execution) => (execution.toolCalls.at(-1)!.outcome = "policy_rejection")],
      ["question before reads", (execution) => (execution.toolCalls.at(-1)!.sequence = 2)],
      ["wrong question actor", (execution) => (execution.toolCalls.at(-1)!.threadId = "other-thread")],
      ["child question actor", (execution) => (execution.toolCalls.at(-1)!.childThreadId = "child-thread")],
      [
        "wrong stable id",
        (execution) =>
          (((execution.toolCalls.at(-1)!.input as { questions: Array<{ id: string }> }).questions[0]!.id as string) =
            "other_preference"),
      ],
      [
        "multiple questions",
        (execution) => (execution.toolCalls.at(-1)!.input as { questions: unknown[] }).questions.push(question()),
      ],
      [
        "unbounded options",
        (execution) =>
          ((execution.toolCalls.at(-1)!.input as { questions: Array<{ options: unknown[] }> }).questions[0]!.options =
            []),
      ],
      [
        "guessed preference after failed question",
        (execution) => {
          execution.toolCalls.at(-1)!.outcome = "policy_rejection";
          execution.userInputRequests = [];
        },
      ],
      [
        "preference omitted from plan",
        (execution) =>
          replaceFinalText(execution, finalText(execution.world).replaceAll(execution.world.preference, "")),
      ],
    ];

    for (const [name, mutate] of cases) {
      const execution = recoveryExecution();
      mutate(execution);
      expect(planConvergeTask.evaluate(execution).passed, name).toBe(false);
    }
  });

  test("accepts the request-user-input contract maximum of four bounded options", () => {
    const execution = directExecution();
    const asked = (execution.toolCalls.at(-1)!.input as { questions: Array<{ options: unknown[] }> }).questions[0]!;
    asked.options = [
      { label: "Immediate", description: "Release to every environment at once." },
      { label: "Canary", description: "Ramp gradually while monitoring metrics." },
      { label: "Staged", description: "Release through environments in order." },
      { label: "Flagged", description: "Enable for selected users first." },
    ];
    expect(planConvergeTask.evaluate(execution)).toEqual({ passed: true });

    asked.options.push({ label: "Extra", description: "Exceeds the protocol contract." });
    expect(planConvergeTask.evaluate(execution)).toMatchObject({
      passed: false,
      code: "plan_converge.question",
    });
  });

  test("preserves the exact direct path and rejects provider-neutral trace slack", () => {
    const cases: Array<[string, (execution: RuntimeEvalExecution<PlanConvergeWorld>) => void]> = [
      ["OpenAI relative recovery", (execution) => execution.toolCalls.unshift(failedRelativeRead(0, API_PATH))],
      ["wrong direct read order", (execution) => swap(execution.toolCalls, 0, 1)],
      ["extra direct read", (execution) => execution.toolCalls.splice(2, 0, successfulRead(3, API_PATH, "api-hidden"))],
      ["missing direct actor", (execution) => delete execution.toolCalls[0]!.threadId],
      ["non-exact direct path", (execution) => (execution.toolCalls[0]!.input = { file_path: `/tmp/${API_PATH}` })],
    ];

    for (const [name, mutate] of cases) {
      const execution = directExecution();
      mutate(execution);
      expect(planConvergeTask.evaluate(execution).passed, name).toBe(false);
    }
  });
});

function directExecution(): RuntimeEvalExecution<PlanConvergeWorld> {
  const execution = baseExecution("openai");
  execution.toolCalls = [
    successfulRead(1, API_PATH, execution.world.apiFact),
    successfulRead(2, UI_PATH, execution.world.uiFact),
    successfulQuestion(3, execution.world.preference),
  ];
  return execution;
}

function recoveryExecution(): RuntimeEvalExecution<PlanConvergeWorld> {
  const execution = baseExecution("anthropic");
  execution.toolCalls = [
    failedRelativeRead(1, API_PATH),
    failedRelativeRead(2, UI_PATH),
    successfulRead(3, API_PATH, execution.world.apiFact),
    successfulRead(4, UI_PATH, execution.world.uiFact),
    successfulQuestion(5, execution.world.preference),
  ];
  return execution;
}

function baseExecution(provider: "anthropic" | "openai"): RuntimeEvalExecution<PlanConvergeWorld> {
  const world: PlanConvergeWorld = {
    root: "$WORKSPACE",
    seed: "seed",
    apiFact: "api-hidden",
    uiFact: "ui-hidden",
    preference: "preference-hidden",
    expected: "",
    protectedPaths: [],
    allowedChanges: [],
  };
  const askedQuestion = question();
  return {
    taskId: planConvergeTask.id,
    profile: { provider, model: "test-model", effort: "medium" },
    seed: world.seed,
    startedAt: new Date(0).toISOString(),
    elapsedMs: 1,
    termination: "completed",
    turns: [
      {
        index: 0,
        threadId: THREAD_ID,
        clientPrompt: "plan",
        startedAt: new Date(0).toISOString(),
        elapsedMs: 1,
        termination: "completed",
        coreEvents: [],
        runtimeEvents: [],
        notifications: [],
        messages: [assistant(finalText(world), provider)],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ],
    compactions: [],
    threadCwd: world.root,
    advertisedTools: [],
    threadReads: [],
    protocolActions: [],
    providerCalls: [providerCall(provider)],
    toolCalls: [],
    toolOutputFiles: [],
    approvals: [],
    userInputRequests: [
      {
        id: 1,
        method: "userInput/request",
        params: { threadId: THREAD_ID, request: { questions: [structuredClone(askedQuestion)] } },
      },
    ],
    logs: [],
    session: { threadId: THREAD_ID, lines: [{ id: THREAD_ID }] },
    childSessions: [],
    workspace: { initial: { entries: [] }, final: { entries: [] } },
    runtimeState: { initial: [], final: [], diff: [] },
    verifier: { argv: [], exitCode: 0, elapsedMs: 1, stdout: "", stderr: "", timedOut: false },
    world,
  };
}

function failedRelativeRead(sequence: number, path: string): RuntimeToolTrace {
  const error = `Error: file_path must be absolute: ${path}`;
  return {
    sequence,
    toolCallId: `read-failed-${sequence}`,
    name: "read",
    capability: "read",
    threadId: THREAD_ID,
    input: { file_path: path },
    outcome: "runtime_error",
    error,
    output: { output: error, metadata: { error: true } },
  };
}

function successfulRead(sequence: number, path: string, value: string): RuntimeToolTrace {
  return {
    sequence,
    toolCallId: `read-success-${sequence}`,
    name: "read",
    capability: "read",
    threadId: THREAD_ID,
    input: { file_path: absolute(path) },
    outcome: "success",
    output: { output: `1\t${value}\n2\t` },
  };
}

function successfulQuestion(sequence: number, answer: string): RuntimeToolTrace {
  const askedQuestion = question();
  return {
    sequence,
    toolCallId: `question-${sequence}`,
    name: "request_user_input",
    capability: "user_input",
    threadId: THREAD_ID,
    input: { questions: [askedQuestion] },
    outcome: "success",
    output: { output: `[${askedQuestion.header}] ${askedQuestion.question}\nAnswer: ${answer}` },
  };
}

function question() {
  return {
    id: "rollout_preference",
    header: "Rollout",
    question: "Which rollout preference should the plan use?",
    options: [{ label: "Custom", description: "Supply the unavailable rollout preference." }],
  };
}

function absolute(path: string): string {
  return `$WORKSPACE/${path}`;
}

function finalText(world: PlanConvergeWorld): string {
  return `<proposed_plan>\n${world.apiFact}\n${world.uiFact}\n${world.preference}\n</proposed_plan>`;
}

function replaceFinalText(execution: RuntimeEvalExecution<PlanConvergeWorld>, text: string): void {
  const message = execution.turns[0]!.messages[0]!;
  if (message.role !== "assistant") throw new Error("Expected assistant message.");
  message.content = [{ type: "text", text }];
}

function assistant(text: string, provider: "anthropic" | "openai") {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    model: {
      provider,
      modelId: "test-model",
      contextWindow: 100_000,
      maxOutputTokens: 8_192,
      supportsThinking: false,
    },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn" as const,
    timestamp: 0,
  };
}

function providerCall(provider: "anthropic" | "openai") {
  return {
    sequence: 1,
    model: { provider, modelId: "test-model" },
    systemPrompt: { totalCount: 0, includedCount: 0, omittedCount: 0, items: [] },
    messages: { totalCount: 0, includedCount: 0, omittedCount: 0, items: [] },
    tools: {
      totalCount: 2,
      includedCount: 2,
      omittedCount: 0,
      items: [
        { name: "read", description: "", inputSchema: {} },
        { name: "request_user_input", description: "", inputSchema: {} },
      ],
    },
    streamOptions: {},
    bounds: {
      maxSourceItems: 1,
      maxNestedItems: 1,
      maxObjectProperties: 1,
      maxStringChars: 1,
      maxDepth: 1,
      truncatedStrings: 0,
      omittedNestedItems: 0,
      omittedObjectProperties: 0,
    },
  } as unknown as RuntimeEvalExecution<PlanConvergeWorld>["providerCalls"][number];
}

function swap<T>(values: T[], left: number, right: number): void {
  const value = values[left]!;
  values[left] = values[right]!;
  values[right] = value;
}
