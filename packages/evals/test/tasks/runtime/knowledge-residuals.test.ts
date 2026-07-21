// @summary Focused evaluator regressions for bounded knowledge write recovery and deletion confirmation

import { describe, expect, test } from "bun:test";
import type { RuntimeEvalExecution, RuntimeToolTrace } from "../../../src/runtime-task";
import type { EvalProvider } from "../../../src/task";
import { type KnowledgeForgetWorld, knowledgeForgetTask } from "../../../src/tasks/runtime/knowledge-forget";
import {
  type KnowledgeIntentSplitWorld,
  knowledgeIntentSplitTask,
} from "../../../src/tasks/runtime/knowledge-intent-split";

describe("knowledge residual evaluator calibration", () => {
  test("keeps direct intent-split evidence provider-native and bumps the fixture contract", () => {
    expect(knowledgeIntentSplitTask.fixtureVersion).toBe("knowledge-intent-split-v4");
    expect(knowledgeIntentSplitTask.evaluate(intentSplitExecution("openai"))).toEqual({ passed: true });
    expect(knowledgeIntentSplitTask.evaluate(intentSplitExecution("anthropic"))).toEqual({ passed: true });
  });

  test("accepts only the exact Anthropic relative-create recovery", () => {
    expect(knowledgeIntentSplitTask.evaluate(intentSplitRecoveryExecution())).toEqual({ passed: true });

    const cases: Array<[string, (execution: RuntimeEvalExecution<KnowledgeIntentSplitWorld>) => void]> = [
      ["wrong provider", (execution) => (execution.profile.provider = "openai")],
      [
        "wrong relative path",
        (execution) => ((execution.toolCalls[2]!.input as { file_path: string }).file_path = "OTHER.txt"),
      ],
      [
        "absolute failed path",
        (execution) => ((execution.toolCalls[2]!.input as { file_path: string }).file_path = "$WORKSPACE/CURRENT.txt"),
      ],
      [
        "divergent recovery content",
        (execution) => ((execution.toolCalls[2]!.input as { new_string: string }).new_string = "wrong\n"),
      ],
      ["wrong failed tool", (execution) => (execution.toolCalls[2]!.name = "apply_patch")],
      ["non-error recovery", (execution) => (execution.toolCalls[2]!.outcome = "success")],
      ["policy rejection", (execution) => (execution.toolCalls[2]!.outcome = "policy_rejection")],
      ["wrong error", (execution) => (execution.toolCalls[2]!.error = "different")],
      [
        "wrong output text",
        (execution) => ((execution.toolCalls[2]!.output as { output: string }).output = "different"),
      ],
      [
        "missing error metadata",
        (execution) => delete (execution.toolCalls[2]!.output as { metadata?: unknown }).metadata,
      ],
      [
        "extra error metadata",
        (execution) =>
          ((execution.toolCalls[2]!.output as { metadata: Record<string, unknown> }).metadata.extra = true),
      ],
      ["non-adjacent sequence", (execution) => (execution.toolCalls[3]!.sequence = 5)],
      [
        "intervening safe search",
        (execution) =>
          execution.toolCalls.splice(
            3,
            0,
            trace(3, "search_knowledge", "knowledge", { id: execution.world.knowledgeId }, "thread-1"),
          ),
      ],
      ["missing actor", (execution) => delete execution.toolCalls[2]!.threadId],
      ["different actor", (execution) => (execution.toolCalls[3]!.threadId = "thread-2")],
      ["child recovery", (execution) => (execution.toolCalls[2]!.childThreadId = "child-1")],
      ["child retry", (execution) => (execution.toolCalls[3]!.childThreadId = "child-1")],
      [
        "extra general error",
        (execution) => {
          const extra = trace(5, "edit", "write", { file_path: "OTHER.txt" }, "thread-1");
          extra.outcome = "runtime_error";
          extra.error = "different";
          execution.toolCalls.push(extra);
        },
      ],
    ];

    for (const [label, mutate] of cases) {
      const execution = intentSplitRecoveryExecution();
      mutate(execution);
      expect(knowledgeIntentSplitTask.evaluate(execution).passed, label).toBe(false);
    }
  });

  test("accepts safe knowledge verification searches after the durable update and before create recovery", () => {
    const execution = intentSplitRecoveryExecution();
    const [search, update, recovery, write] = execution.toolCalls;
    if (!search || !update || !recovery || !write) throw new Error("Expected recovery fixture calls.");
    const secondSearch = trace(3, "search_knowledge", "knowledge", { query: "OLD_AUDIENCE" }, "thread-1");
    execution.toolCalls = [update, search, secondSearch, recovery, write];
    resequence(execution.toolCalls);

    expect(knowledgeIntentSplitTask.evaluate(execution)).toEqual({
      passed: true,
      diagnostics: [
        {
          dimension: "efficiency",
          code: "knowledge_intent_split.second_safe_search",
          message: "A second bounded read-only knowledge search was used before successful completion.",
        },
      ],
    });
  });

  test("accepts an exact-id plus nontransient optional lookup without broadening search keys", () => {
    const combined = intentSplitExecution("anthropic");
    combined.toolCalls[0]!.sequence = 2;
    combined.toolCalls[1]!.sequence = 3;
    combined.toolCalls.unshift(
      trace(
        1,
        "search_knowledge",
        "knowledge",
        { id: combined.world.knowledgeId, query: "review audience" },
        "thread-1",
      ),
    );
    expect(knowledgeIntentSplitTask.evaluate(combined)).toEqual({ passed: true });

    const cases: Array<[string, (execution: typeof combined) => void]> = [
      ["wrong id", (execution) => ((execution.toolCalls[0]!.input as { id: string }).id = "preference.other")],
      [
        "transient query",
        (execution) => ((execution.toolCalls[0]!.input as { query: string }).query = execution.world.transientValue),
      ],
      ["empty query", (execution) => ((execution.toolCalls[0]!.input as { query: string }).query = " ")],
      [
        "extra key",
        (execution) => ((execution.toolCalls[0]!.input as Record<string, unknown>).id_prefix = "preference."),
      ],
    ];
    for (const [label, mutate] of cases) {
      const execution = structuredClone(combined);
      mutate(execution);
      expect(knowledgeIntentSplitTask.evaluate(execution).passed, label).toBe(false);
    }
  });

  test("accepts the preserved parallel safe searches before the exact Anthropic mutations", () => {
    const execution = intentSplitParallelSearchExecution();

    expect(execution.toolCalls.map(({ sequence, name, input }) => ({ sequence, name, input }))).toEqual([
      {
        sequence: 1,
        name: "search_knowledge",
        input: { id_prefix: execution.world.knowledgeId },
      },
      { sequence: 2, name: "search_knowledge", input: { query: "review audience" } },
      {
        sequence: 3,
        name: "update_knowledge",
        input: expect.objectContaining({
          action: "upsert",
          id: execution.world.knowledgeId,
          content: execution.world.content,
        }),
      },
      {
        sequence: 4,
        name: "edit",
        input: expect.objectContaining({ file_path: "$WORKSPACE/CURRENT.txt", new_string: execution.world.expected }),
      },
    ]);
    expect(knowledgeIntentSplitTask.limits.maxToolCalls).toBe(5);
    expect(knowledgeIntentSplitTask.evaluate(execution)).toEqual({
      passed: true,
      diagnostics: [
        {
          dimension: "efficiency",
          code: "knowledge_intent_split.second_safe_search",
          message: "A second bounded read-only knowledge search was used before successful completion.",
        },
      ],
    });

    const withCreateRecovery = intentSplitRecoveryExecution();
    withCreateRecovery.toolCalls.splice(
      1,
      0,
      trace(2, "search_knowledge", "knowledge", { id_prefix: withCreateRecovery.world.knowledgeId }, "thread-1"),
    );
    resequence(withCreateRecovery.toolCalls);
    expect(withCreateRecovery.toolCalls).toHaveLength(5);
    expect(knowledgeIntentSplitTask.evaluate(withCreateRecovery)).toEqual({
      passed: true,
      diagnostics: expect.any(Array),
    });
  });

  test("rejects unsafe parallel searches and wrong or extra intent-split mutations", () => {
    const cases: Array<[string, (execution: RuntimeEvalExecution<KnowledgeIntentSplitWorld>) => void]> = [
      [
        "wrong prefix",
        (execution) => ((execution.toolCalls[0]!.input as { id_prefix: string }).id_prefix = "preference.unrelated"),
      ],
      [
        "third search",
        (execution) => {
          execution.toolCalls.splice(
            2,
            0,
            trace(3, "search_knowledge", "knowledge", { query: "audience preference" }, "thread-1"),
          );
          resequence(execution.toolCalls);
        },
      ],
      [
        "wrong durable content",
        (execution) =>
          ((execution.toolCalls[2]!.input as { content: string }).content = "Preferred review audience is WRONG."),
      ],
      [
        "extra knowledge mutation",
        (execution) => {
          execution.toolCalls.splice(
            3,
            0,
            trace(
              4,
              "update_knowledge",
              "knowledge",
              { action: "upsert", id: "preference.extra", type: "preference", content: "extra" },
              "thread-1",
            ),
          );
          resequence(execution.toolCalls);
        },
      ],
      [
        "extra file mutation",
        (execution) => {
          execution.toolCalls.push(providerWrite(5, "anthropic", "OTHER.txt", "extra\n"));
        },
      ],
      [
        "wrong file path",
        (execution) => ((execution.toolCalls[3]!.input as { file_path: string }).file_path = "$WORKSPACE/OTHER.txt"),
      ],
    ];

    for (const [label, mutate] of cases) {
      const execution = intentSplitParallelSearchExecution();
      mutate(execution);
      expect(knowledgeIntentSplitTask.evaluate(execution).passed, label).toBe(false);
    }
  });

  test("keeps direct forget evidence provider-native and bumps the fixture contract", () => {
    expect(knowledgeForgetTask.fixtureVersion).toBe("knowledge-forget-v6");
    expect(knowledgeForgetTask.evaluate(forgetExecution("openai"))).toEqual({ passed: true });
    expect(knowledgeForgetTask.evaluate(forgetExecution("anthropic"))).toEqual({ passed: true });
  });

  test("accepts only the exact Anthropic relative-create recovery while forgetting knowledge", () => {
    expect(knowledgeForgetTask.evaluate(forgetRecoveryExecution())).toMatchObject({ passed: true });

    const cases: Array<[string, (execution: RuntimeEvalExecution<KnowledgeForgetWorld>) => void]> = [
      ["wrong provider", (execution) => (execution.profile.provider = "openai")],
      [
        "wrong relative path",
        (execution) => ((execution.toolCalls[1]!.input as { file_path: string }).file_path = "OTHER.txt"),
      ],
      ["successful first write", (execution) => (execution.toolCalls[1]!.outcome = "success")],
      ["wrong error", (execution) => (execution.toolCalls[1]!.error = "different")],
      [
        "divergent retry content",
        (execution) => ((execution.toolCalls[2]!.input as { new_string: string }).new_string = "wrong\n"),
      ],
      ["different actor", (execution) => (execution.toolCalls[2]!.threadId = "thread-2")],
      ["non-adjacent retry", (execution) => (execution.toolCalls[2]!.sequence = 4)],
    ];

    for (const [label, mutate] of cases) {
      const execution = forgetRecoveryExecution();
      mutate(execution);
      expect(knowledgeForgetTask.evaluate(execution).passed, label).toBe(false);
    }
  });

  test("accepts one bounded post-delete absence confirmation for either provider", () => {
    for (const provider of ["openai", "anthropic"] as const) {
      expect(knowledgeForgetTask.evaluate(withPostDeleteConfirmation(forgetExecution(provider)))).toEqual({
        passed: true,
        diagnostics: [
          {
            dimension: "efficiency",
            code: "knowledge_forget.confirmation_search",
            message: expect.any(String),
          },
        ],
      });
    }
    const beforeWrite = withPostDeleteConfirmation(forgetExecution("openai"));
    beforeWrite.toolCalls[2]!.sequence = 2;
    beforeWrite.toolCalls[1]!.sequence = 3;
    [beforeWrite.toolCalls[1], beforeWrite.toolCalls[2]] = [beforeWrite.toolCalls[2]!, beforeWrite.toolCalls[1]!];
    expect(knowledgeForgetTask.evaluate(beforeWrite)).toMatchObject({ passed: true });
  });

  test("rejects unsafe, reordered, repeated, failed, or leaky post-delete confirmation", () => {
    const cases: Array<[string, (execution: RuntimeEvalExecution<KnowledgeForgetWorld>) => void]> = [
      [
        "non-prefix id",
        (execution) => ((execution.toolCalls[2]!.input as { id_prefix: string }).id_prefix = "project."),
      ],
      ["broad empty prefix", (execution) => ((execution.toolCalls[2]!.input as { id_prefix: string }).id_prefix = "")],
      ["missing prefix", (execution) => delete (execution.toolCalls[2]!.input as { id_prefix?: string }).id_prefix],
      ["extra input key", (execution) => ((execution.toolCalls[2]!.input as Record<string, unknown>).limit = 10)],
      ["empty query", (execution) => ((execution.toolCalls[2]!.input as { query: string }).query = " ")],
      [
        "transient query leakage",
        (execution) => ((execution.toolCalls[2]!.input as { query: string }).query = execution.world.taskValue),
      ],
      ["runtime error", (execution) => (execution.toolCalls[2]!.outcome = "runtime_error")],
      ["wrong capability", (execution) => (execution.toolCalls[2]!.capability = "read")],
      ["missing parent actor", (execution) => delete execution.toolCalls[2]!.threadId],
      ["different parent actor", (execution) => (execution.toolCalls[2]!.threadId = "thread-2")],
      ["child confirmation", (execution) => (execution.toolCalls[2]!.childThreadId = "child-1")],
      [
        "matched result count",
        (execution) =>
          ((execution.toolCalls[2]!.output as { metadata: { matchCount: number } }).metadata.matchCount = 1),
      ],
      [
        "matched result id",
        (execution) =>
          ((execution.toolCalls[2]!.output as { metadata: { ids: string[] } }).metadata.ids = [
            execution.world.knowledgeId,
          ]),
      ],
      ["missing metadata", (execution) => delete (execution.toolCalls[2]!.output as { metadata?: unknown }).metadata],
      [
        "extra metadata",
        (execution) =>
          ((execution.toolCalls[2]!.output as { metadata: Record<string, unknown> }).metadata.extra = true),
      ],
      [
        "wrong absence output",
        (execution) => ((execution.toolCalls[2]!.output as { output: string }).output = "No matches"),
      ],
      [
        "forgotten value leakage",
        (execution) =>
          ((execution.toolCalls[2]!.output as Record<string, unknown>).render = {
            outputSummary: execution.world.forgottenValue,
          }),
      ],
      [
        "target content leakage",
        (execution) =>
          ((execution.toolCalls[2]!.output as Record<string, unknown>).render = {
            outputSummary: execution.world.targetContent,
          }),
      ],
      [
        "confirmation before delete",
        (execution) => {
          execution.toolCalls[2]!.sequence = 1;
          execution.toolCalls[0]!.sequence = 2;
          execution.toolCalls[1]!.sequence = 3;
          [execution.toolCalls[0], execution.toolCalls[2]] = [execution.toolCalls[2]!, execution.toolCalls[0]!];
        },
      ],
      [
        "repeated confirmation",
        (execution) =>
          execution.toolCalls.push({ ...structuredClone(execution.toolCalls[2]!), sequence: 4, toolCallId: "tool-4" }),
      ],
    ];

    for (const [label, mutate] of cases) {
      const execution = withPostDeleteConfirmation(forgetExecution("openai"));
      mutate(execution);
      expect(knowledgeForgetTask.evaluate(execution).passed, label).toBe(false);
    }
  });

  test("preserves up to two safe pre-delete searches without treating them as confirmations", () => {
    const execution = forgetExecution("openai");
    execution.toolCalls[0]!.sequence = 3;
    execution.toolCalls[1]!.sequence = 4;
    execution.toolCalls.unshift(
      trace(1, "search_knowledge", "knowledge", { id: execution.world.knowledgeId }, "thread-1"),
      trace(2, "search_knowledge", "knowledge", { query: "deployment window" }, "thread-1"),
    );

    expect(knowledgeForgetTask.evaluate(execution)).toEqual({ passed: true });
  });
});

function intentSplitExecution(provider: EvalProvider): RuntimeEvalExecution<KnowledgeIntentSplitWorld> {
  const world: KnowledgeIntentSplitWorld = {
    root: "$WORKSPACE",
    seed: "seed",
    knowledgeId: "preference.review-audience",
    durableValue: "AUDIENCE_future",
    transientValue: "CURRENT_once",
    content: "Preferred review audience is AUDIENCE_future.",
    tags: ["review", "audience"],
    expected: "CURRENT_once\n",
    expectedHash: "split-hash",
    protectedPaths: [],
    allowedChanges: ["CURRENT.txt"],
  };
  const execution = baseExecution(world, provider);
  execution.toolCalls = [
    trace(
      1,
      "update_knowledge",
      "knowledge",
      {
        action: "upsert",
        id: world.knowledgeId,
        type: "preference",
        content: world.content,
        tags: world.tags,
      },
      "thread-1",
    ),
    providerWrite(2, provider, "CURRENT.txt", world.expected),
  ];
  execution.workspace.final.entries = [{ path: "CURRENT.txt", kind: "file", size: 13, sha256: world.expectedHash }];
  return execution;
}

function intentSplitRecoveryExecution(): RuntimeEvalExecution<KnowledgeIntentSplitWorld> {
  const execution = intentSplitExecution("anthropic");
  execution.toolCalls[0]!.sequence = 2;
  execution.toolCalls[1]!.sequence = 4;
  execution.toolCalls.unshift(trace(1, "search_knowledge", "knowledge", { query: "review audience" }, "thread-1"));
  const failed = trace(
    3,
    "edit",
    "write",
    {
      file_path: "CURRENT.txt",
      old_string: "",
      new_string: execution.world.expected,
      replace_all: false,
    },
    "thread-1",
  );
  failed.outcome = "runtime_error";
  failed.error = "Error: file_path must be absolute: CURRENT.txt";
  failed.output = {
    output: "Error: file_path must be absolute: CURRENT.txt",
    metadata: { error: true },
  };
  execution.toolCalls.splice(2, 0, failed);
  return execution;
}

function intentSplitParallelSearchExecution(): RuntimeEvalExecution<KnowledgeIntentSplitWorld> {
  const execution = intentSplitExecution("anthropic");
  execution.toolCalls[0]!.sequence = 3;
  execution.toolCalls[1]!.sequence = 4;
  execution.toolCalls.unshift(
    trace(1, "search_knowledge", "knowledge", { id_prefix: execution.world.knowledgeId }, "thread-1"),
    trace(2, "search_knowledge", "knowledge", { query: "review audience" }, "thread-1"),
  );
  return execution;
}

function forgetExecution(provider: EvalProvider): RuntimeEvalExecution<KnowledgeForgetWorld> {
  const world: KnowledgeForgetWorld = {
    root: "$WORKSPACE",
    seed: "seed",
    knowledgeId: "preference.deploy-window",
    forgottenValue: "WINDOW_old",
    targetContent: "Preferred deployment window is WINDOW_old.",
    taskValue: "TASK_once",
    controlEntry: {
      id: "preference.control-format",
      timestamp: "2026-07-18T00:01:00.000Z",
      type: "preference",
      content: "Preferred control format is CONTROL_keep.",
      confidence: 0.9,
      tags: ["control", "format"],
    },
    expected: "TASK_once\n",
    expectedHash: "forget-hash",
    protectedPaths: [],
    allowedChanges: ["FORGET.txt"],
  };
  const execution = baseExecution(world, provider);
  execution.toolCalls = [
    trace(1, "update_knowledge", "knowledge", { action: "delete", id: world.knowledgeId }, "thread-1"),
    providerWrite(2, provider, "FORGET.txt", world.expected),
  ];
  execution.workspace.final.entries = [{ path: "FORGET.txt", kind: "file", size: 10, sha256: world.expectedHash }];
  return execution;
}

function forgetRecoveryExecution(): RuntimeEvalExecution<KnowledgeForgetWorld> {
  const execution = forgetExecution("anthropic");
  const [deletion, write] = execution.toolCalls;
  deletion!.sequence = 4;
  write!.sequence = 3;
  const search = trace(
    1,
    "search_knowledge",
    "knowledge",
    { id: execution.world.knowledgeId, query: "deployment window" },
    "thread-1",
  );
  const error = "Error: file_path must be absolute: FORGET.txt";
  const failed = trace(
    2,
    "edit",
    "write",
    {
      file_path: "FORGET.txt",
      old_string: "",
      new_string: execution.world.expected,
      replace_all: false,
    },
    "thread-1",
  );
  failed.outcome = "runtime_error";
  failed.error = error;
  failed.output = { output: error, metadata: { error: true } };
  execution.toolCalls = [search, failed, write!, deletion!];
  return execution;
}

function withPostDeleteConfirmation(
  execution: RuntimeEvalExecution<KnowledgeForgetWorld>,
): RuntimeEvalExecution<KnowledgeForgetWorld> {
  const confirmation = trace(
    3,
    "search_knowledge",
    "knowledge",
    { id_prefix: "preference.", query: "deployment window" },
    "thread-1",
  );
  confirmation.output = {
    output: "No knowledge entries found",
    metadata: { matchCount: 0, ids: [] },
  };
  execution.toolCalls.push(confirmation);
  return execution;
}

function providerWrite(sequence: number, provider: EvalProvider, path: string, content: string): RuntimeToolTrace {
  if (provider === "openai") {
    return trace(
      sequence,
      "apply_patch",
      "write",
      {
        patch: `*** Begin Patch\n*** Add File: ${path}\n+${content.slice(0, -1)}\n*** End Patch`,
      },
      "thread-1",
    );
  }
  return trace(
    sequence,
    "edit",
    "write",
    { file_path: `$WORKSPACE/${path}`, old_string: "", new_string: content, replace_all: false },
    "thread-1",
  );
}

function baseExecution<T>(world: T, provider: EvalProvider): RuntimeEvalExecution<T> {
  return {
    taskId: "test",
    profile: { provider, model: "test-model", effort: "medium" },
    seed: "seed",
    startedAt: new Date(0).toISOString(),
    elapsedMs: 1,
    termination: "completed",
    turns: [],
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
    session: { threadId: "thread-1", lines: [] },
    childSessions: [],
    workspace: { initial: { entries: [] }, final: { entries: [] } },
    runtimeState: { initial: [], final: [], diff: [] },
    verifier: { argv: [], exitCode: 0, elapsedMs: 1, stdout: "", stderr: "", timedOut: false },
    world,
  };
}

function trace(
  sequence: number,
  name: string,
  capability: RuntimeToolTrace["capability"],
  input: unknown,
  threadId: string,
): RuntimeToolTrace {
  return { sequence, toolCallId: `tool-${sequence}`, name, capability, input, outcome: "success", threadId };
}

function resequence(toolCalls: RuntimeToolTrace[]): void {
  toolCalls.forEach((call, index) => {
    call.sequence = index + 1;
    call.toolCallId = `tool-${index + 1}`;
  });
}
