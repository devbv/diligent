// @summary Semantic JSON oracle regressions for manual-compaction-resume

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACTION_MIN_INPUT_TOKENS } from "@diligent/core/compaction-contract";
import { removeTemporaryRoot } from "../../../src/runner/runtime-workspace";
import type { RuntimeEvalExecution } from "../../../src/runtime-task";
import { writeFixture } from "../../../src/tasks/runtime/helpers";
import {
  type ManualCompactionResumeWorld,
  manualCompactionResumeTask,
} from "../../../src/tasks/runtime/manual-compaction-resume";

describe("manual-compaction-resume", () => {
  test("declares an eligible candidate while leaving compaction mechanics out of live scoring", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-eval-manual-compaction-contract-"));
    try {
      const world = await manualCompactionResumeTask.setup("shared-seed-123", root);
      const first = manualCompactionResumeTask.createSteps(world)[0];
      expect(first.kind).toBe("turn");
      expect(first.kind === "turn" ? Math.ceil(first.message.length / 4) : 0).toBeGreaterThanOrEqual(
        COMPACTION_MIN_INPUT_TOKENS,
      );
      await writeFixture(root, { "CONTEXT.json": world.expected });
      const verifier = await manualCompactionResumeTask.verify!(world, new AbortController().signal);
      const input = execution(world, verifier);
      input.compactions = [];
      input.session.lines = [{ type: "session", id: "thread-1" }];
      expect(manualCompactionResumeTask.evaluate(input)).toEqual({ passed: true });
    } finally {
      await removeTemporaryRoot(root);
    }
  });
  test("accepts JSON whitespace and key-order variants with the exact values and one final newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-eval-manual-compaction-semantic-"));
    try {
      const world = await manualCompactionResumeTask.setup("shared-seed-123", root);
      await writeFixture(root, {
        "CONTEXT.json": `  {\n  "beta": ${JSON.stringify(world.beta)},\n  "alpha": ${JSON.stringify(world.alpha)}\n}\n`,
      });

      const verifier = await manualCompactionResumeTask.verify!(world, new AbortController().signal);
      expect(verifier).toMatchObject({
        argv: ["semantic-json", "CONTEXT.json"],
        exitCode: 0,
        timedOut: false,
      });
      expect(manualCompactionResumeTask.evaluate(execution(world, verifier))).toEqual({ passed: true });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("rejects wrong values, additional fields, and a missing or duplicated final newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-eval-manual-compaction-negative-"));
    try {
      const world = await manualCompactionResumeTask.setup("shared-seed-123", root);
      const cases = [
        `${JSON.stringify({ alpha: "wrong", beta: world.beta })}\n`,
        `${JSON.stringify({ alpha: world.alpha, beta: world.beta, extra: true })}\n`,
        JSON.stringify({ alpha: world.alpha, beta: world.beta }),
        `${JSON.stringify({ alpha: world.alpha, beta: world.beta })}\n\n`,
        `${JSON.stringify({ alpha: world.alpha, beta: world.beta })}\n \n`,
      ];

      for (const content of cases) {
        await writeFixture(root, { "CONTEXT.json": content });
        const verifier = await manualCompactionResumeTask.verify!(world, new AbortController().signal);
        expect(verifier.exitCode, JSON.stringify(content)).toBe(1);
        const result = manualCompactionResumeTask.evaluate(execution(world, verifier));
        expect(result.passed).toBe(false);
        if (!result.passed)
          expect(result.dimension, JSON.stringify(content)).toBe(
            content.includes("wrong") || content.includes("extra") ? "semantic_goal" : "format_contract",
          );
      }
    } finally {
      await removeTemporaryRoot(root);
    }
  });
});

function execution(
  world: ManualCompactionResumeWorld,
  verifier: NonNullable<RuntimeEvalExecution<ManualCompactionResumeWorld>["verifier"]>,
): RuntimeEvalExecution<ManualCompactionResumeWorld> {
  return {
    taskId: manualCompactionResumeTask.id,
    profile: { provider: "anthropic", model: "test-model", effort: "medium" },
    seed: world.seed,
    startedAt: new Date(0).toISOString(),
    elapsedMs: 1,
    termination: "completed",
    turns: [turn(0), turn(1)],
    compactions: [
      {
        threadId: "thread-1",
        response: { compacted: true, entryCount: 1, tokensBefore: 10, tokensAfter: 5, summary: "facts" },
        notifications: [],
      },
    ],
    threadCwd: "$WORKSPACE",
    advertisedTools: [],
    threadReads: [],
    protocolActions: [],
    providerCalls: [],
    toolCalls: [
      {
        sequence: 1,
        toolCallId: "write-context",
        name: "edit",
        capability: "write",
        input: {},
        outcome: "success",
      },
    ],
    toolOutputFiles: [],
    approvals: [],
    userInputRequests: [],
    logs: [],
    session: {
      threadId: "thread-1",
      lines: [
        { type: "session", id: "thread-1" },
        { type: "compaction", id: "compact", parentId: null, summary: "facts" },
      ],
    },
    childSessions: [],
    workspace: {
      initial: { entries: [] },
      final: {
        entries: [{ path: "CONTEXT.json", kind: "file", size: 1, sha256: "representation-independent" }],
      },
    },
    runtimeState: { initial: [], final: [], diff: [] },
    verifier,
    world,
  };
}

function turn(index: number): RuntimeEvalExecution<unknown>["turns"][number] {
  return {
    index,
    threadId: "thread-1",
    clientPrompt: "prompt",
    startedAt: new Date(0).toISOString(),
    elapsedMs: 1,
    termination: "completed",
    coreEvents: [],
    runtimeEvents: [],
    notifications: [],
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}
