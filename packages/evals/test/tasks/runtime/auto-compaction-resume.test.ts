// @summary Contract, evaluator, and assembled-runtime tests for automatic compaction continuation

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStream } from "@diligent/core/event-stream";
import type { ProviderEvent, ProviderResult, StreamFunction } from "@diligent/core/provider-contract";
import { runRuntimeEvalExecution } from "../../../src/runner/runtime-execution";
import { removeTemporaryRoot } from "../../../src/runner/runtime-workspace";
import type { RuntimeEvalExecution } from "../../../src/runtime-task";
import {
  type AutoCompactionResumeWorld,
  autoCompactionResumeTask,
} from "../../../src/tasks/runtime/auto-compaction-resume";
import { createFixtureRuntimeConfig, writeFixture } from "../../../src/tasks/runtime/helpers";
import { assistantMessage } from "../../helpers/fake-stream";

describe("auto-compaction-resume runtime eval", () => {
  test("defines one natural turn with no manual compact or restart step", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-auto-compaction-"));
    try {
      const world = await autoCompactionResumeTask.setup("shared-seed-123", root);
      const steps = autoCompactionResumeTask.createSteps(world);

      expect(steps).toHaveLength(1);
      expect(steps[0]?.kind).toBe("turn");
      expect(steps.some((step) => step.kind === "compact" || step.kind === "restart_and_resume")).toBe(false);
      expect(world.facts).toHaveLength(3);
      expect(new Set(world.facts).size).toBe(3);
      expect(world.protectedPaths).toEqual(["control.txt"]);
      expect(world.allowedChanges).toEqual([world.targetPath]);
      expect(autoCompactionResumeTask.toolPolicy).toEqual({
        allowedTools: ["inflate_context", "apply_patch", "edit"],
        allowedCapabilities: ["execute", "write"],
        allowedCommands: [],
      });
      expect(autoCompactionResumeTask.limits).toMatchObject({
        maxTurns: 5,
        maxToolCalls: 2,
        maxChangedFiles: 1,
        maxUserInputRequests: 0,
        maxChildAgents: 0,
      });
      expect(await readFile(join(root, "control.txt"), "utf8")).toContain("CONTROL_");

      const profile = {
        provider: "openai",
        model: "gpt-5.6-terra",
        effort: "medium",
      } as const;
      const baseline = await createFixtureRuntimeConfig(world, profile);
      const config = await autoCompactionResumeTask.createRuntimeConfig(world, profile);
      expect(config.compaction).toMatchObject({ enabled: true });
      expect(config.compaction.reservePercent).toBeGreaterThan(99);
      expect(config.model).toEqual(baseline.model);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("independent verifier accepts only exact reconstructed bytes and observes abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-auto-compaction-verifier-"));
    try {
      const world = await autoCompactionResumeTask.setup("shared-seed-123", root);
      await writeFixture(root, { [world.targetPath]: world.expected });
      expect(await autoCompactionResumeTask.verify!(world, new AbortController().signal)).toMatchObject({
        exitCode: 0,
        timedOut: false,
      });
      await writeFixture(root, { [world.targetPath]: `${world.expected}extra\n` });
      expect((await autoCompactionResumeTask.verify!(world, new AbortController().signal)).exitCode).toBe(1);
      const aborted = new AbortController();
      aborted.abort();
      expect(await autoCompactionResumeTask.verify!(world, aborted.signal)).toMatchObject({
        exitCode: 1,
        timedOut: true,
      });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("accepts provider-neutral Anthropic edit evidence", async () => {
    const { result } = await assembledExecution("shared-seed-123");
    const execution = structuredClone(result.execution) as RuntimeEvalExecution<AutoCompactionResumeWorld>;
    execution.profile.provider = "anthropic";
    const write = execution.toolCalls[1]!;
    write.name = "edit";
    write.input = {
      file_path: `$WORKSPACE/${execution.world.targetPath}`,
      old_string: "",
      new_string: execution.world.expected,
      replace_all: false,
    };
    for (const notification of execution.turns[0]!.notifications) {
      const params = notification.params as { event?: { toolCallId?: string; toolName?: string } };
      if (params.event?.toolCallId === write.toolCallId) params.event.toolName = "edit";
    }
    for (const line of execution.session.lines) {
      const entry = line as { message?: { toolCallId?: string; toolName?: string } };
      if (entry.message?.toolCallId === write.toolCallId) entry.message.toolName = "edit";
    }
    expect(autoCompactionResumeTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("accepts an optional newline after the exact OpenAI patch envelope", async () => {
    const { result } = await assembledExecution("shared-seed-123");
    const execution = structuredClone(result.execution) as RuntimeEvalExecution<AutoCompactionResumeWorld>;
    const input = execution.toolCalls[1]!.input as { patch: string };
    input.patch += "\n";

    expect(autoCompactionResumeTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("accepts low-level lifecycle, persistence, and provider-call variation with an efficiency diagnostic", async () => {
    const { result } = await assembledExecution("shared-seed-123");
    const execution = structuredClone(result.execution) as RuntimeEvalExecution<AutoCompactionResumeWorld>;
    execution.turns[0]!.notifications = execution.turns[0]!.notifications.filter(
      (notice) => (notice.params as { event?: { type?: string } }).event?.type !== "compaction_start",
    );
    execution.session.lines = execution.session.lines.filter(
      (line) => (line as { type?: string }).type !== "compaction",
    );
    const extra = structuredClone(execution.providerCalls.at(-1)!);
    extra.sequence = Math.max(...execution.providerCalls.map((call) => call.sequence)) + 1;
    execution.providerCalls.push(extra);

    expect(autoCompactionResumeTask.evaluate(execution)).toEqual({
      passed: true,
      diagnostics: [
        {
          dimension: "efficiency",
          code: "auto_compaction_resume.provider_call_variation",
          message: expect.any(String),
        },
      ],
    });
  });

  test("assigns explicit dimensions to adjacent semantic, format, behavior, and runtime-policy failures", async () => {
    const { result } = await assembledExecution("shared-seed-123");
    expect(result.passed).toBe(true);
    const valid = result.execution as RuntimeEvalExecution<AutoCompactionResumeWorld>;
    const endIndex = valid.turns[0]!.notifications.findIndex(
      (notice) => (notice.params as { event?: { type?: string } }).event?.type === "compaction_end",
    );

    const cases: Array<[string, string, (execution: RuntimeEvalExecution<AutoCompactionResumeWorld>) => void]> = [
      ["manual compaction", "runtime_policy", (execution) => execution.compactions.push({} as never)],
      [
        "wrong seeded fact",
        "semantic_goal",
        (execution) => {
          const input = execution.toolCalls[1]!.input as { patch: string };
          input.patch = input.patch.replace(execution.world.facts[0]!, "WRONG_FACT");
        },
      ],
      [
        "wrong trailing bytes",
        "format_contract",
        (execution) => {
          const input = execution.toolCalls[1]!.input as { patch: string };
          input.patch = input.patch.replace("*** End Patch", "+extra\n*** End Patch");
        },
      ],
      [
        "missing artifact",
        "semantic_goal",
        (execution) =>
          (execution.workspace.final.entries = execution.workspace.final.entries.filter(
            (entry) => entry.path !== execution.world.targetPath,
          )),
      ],
      [
        "undeclared mutation",
        "runtime_policy",
        (execution) =>
          execution.workspace.final.entries.push({
            path: "UNDECLARED.txt",
            kind: "file",
            size: 1,
            sha256: "unexpected",
          }),
      ],
      ["wrong write tool", "runtime_policy", (execution) => (execution.toolCalls[1]!.name = "inflate_context")],
      [
        "wrong write path",
        "runtime_policy",
        (execution) => {
          const input = execution.toolCalls[1]!.input as { patch: string };
          input.patch = input.patch.replace(execution.world.targetPath, "OTHER.txt");
        },
      ],
      ["reordered tools", "behavior", (execution) => (execution.toolCalls[0]!.sequence = 3)],
      [
        "extra tool",
        "runtime_policy",
        (execution) => execution.toolCalls.push({ ...execution.toolCalls[0]!, sequence: 3 }),
      ],
      [
        "unbounded provider recovery",
        "runtime_policy",
        (execution) => {
          while (execution.providerCalls.length <= autoCompactionResumeTask.limits.maxTurns + 3) {
            execution.providerCalls.push(structuredClone(execution.providerCalls.at(-1)!));
          }
        },
      ],
    ];

    for (const [name, dimension, mutate] of cases) {
      const execution = structuredClone(valid);
      mutate(execution);
      expect(autoCompactionResumeTask.evaluate(execution), name).toMatchObject({ passed: false, dimension });
    }

    for (const mutate of [
      (execution: RuntimeEvalExecution<AutoCompactionResumeWorld>) =>
        ((
          execution.turns[0]!.notifications[endIndex]!.params as { event: { tokensBefore: number } }
        ).event.tokensBefore = 49_999),
      (execution: RuntimeEvalExecution<AutoCompactionResumeWorld>) => {
        const event = (
          execution.turns[0]!.notifications[endIndex]!.params as {
            event: { tokensBefore: number; tokensAfter: number };
          }
        ).event;
        event.tokensAfter = event.tokensBefore;
      },
    ]) {
      const execution = structuredClone(valid);
      mutate(execution);
      expect(autoCompactionResumeTask.evaluate(execution)).toMatchObject({ passed: true });
    }
  });

  test("leaves terminal classification to the runner", async () => {
    const { result } = await assembledExecution("shared-seed-123");
    const execution = structuredClone(result.execution) as RuntimeEvalExecution<AutoCompactionResumeWorld>;
    execution.termination = "runtime_error";
    execution.turns[0]!.termination = "failed";

    expect(autoCompactionResumeTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("runs actual automatic compaction and resumes the same turn with every seeded fact", async () => {
    const { result, observations } = await assembledExecution("shared-seed-123");

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(observations.sawUncompactedInflation).toBe(true);
    expect(observations.sawFactsBeforeWrite).toBe(true);
    expect(result.execution.compactions).toEqual([]);
    const end = result.execution.turns[0]!.notifications.find(
      (notice) => (notice.params as { event?: { type?: string } }).event?.type === "compaction_end",
    );
    expect(end?.params).toMatchObject({
      event: { tokensBefore: expect.any(Number), tokensAfter: expect.any(Number) },
    });
  });
});

async function assembledExecution(seed: string) {
  const observations = {
    normalCalls: 0,
    summarizerCalls: 0,
    sawUncompactedInflation: false,
    sawFactsBeforeWrite: false,
  };
  const streamFunction: StreamFunction = (model, context, options) => {
    const world = expectedWorld(seed);
    const serialized = JSON.stringify(context.messages);
    const isSummarizer =
      context.tools.length === 0 &&
      context.systemPrompt.some((section) => section.content.includes("CONTEXT CHECKPOINT COMPACTION"));
    if (isSummarizer) {
      observations.summarizerCalls += 1;
      observations.sawUncompactedInflation = serialized.includes("AUTO_COMPACTION_INFLATE_RESULT");
      return oneMessage(model, options.signal, assistantMessage([{ type: "text", text: world.summaryBody }]));
    }

    observations.normalCalls += 1;
    if (observations.normalCalls === 1)
      return oneMessage(
        model,
        options.signal,
        assistantMessage([{ type: "tool_call", id: "auto-inflate-1", name: "inflate_context", input: {} }], "tool_use"),
      );
    if (observations.normalCalls === 2) {
      observations.sawFactsBeforeWrite =
        world.facts.every((fact) => serialized.includes(fact)) && !serialized.includes("auto-write-1");
      return oneMessage(
        model,
        options.signal,
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "auto-write-1",
              name: "apply_patch",
              input: { patch: expectedPatch(world) },
            },
          ],
          "tool_use",
        ),
      );
    }
    return oneMessage(model, options.signal, assistantMessage([{ type: "text", text: "Done." }]));
  };
  const result = await runRuntimeEvalExecution({
    task: autoCompactionResumeTask,
    seed,
    profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
    streamFunction,
  });
  return { result, observations };
}

function expectedWorld(seed: string): AutoCompactionResumeWorld {
  const safeSeed = seed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "seed";
  const facts = ["ORBIT", "CIPHER", "ANCHOR"].map((label) => `${label}_${safeSeed}`);
  const expected = `ORBIT=${facts[0]}\nCIPHER=${facts[1]}\nANCHOR=${facts[2]}\n`;
  return {
    root: "$WORKSPACE",
    seed,
    facts,
    targetPath: "COMPACTED.txt",
    expected,
    expectedHash: "unused-in-stream",
    controlHash: "unused-in-stream",
    summaryBody: `## Goal\nCreate COMPACTED.txt.\n\n## Critical Context\nORBIT=${facts[0]}\nCIPHER=${facts[1]}\nANCHOR=${facts[2]}`,
    protectedPaths: ["control.txt"],
    allowedChanges: ["COMPACTED.txt"],
  };
}

function expectedPatch(world: AutoCompactionResumeWorld): string {
  return `*** Begin Patch\n*** Add File: ${world.targetPath}\n+ORBIT=${world.facts[0]}\n+CIPHER=${world.facts[1]}\n+ANCHOR=${world.facts[2]}\n*** End Patch`;
}

function oneMessage(
  model: Parameters<StreamFunction>[0],
  signal: AbortSignal | undefined,
  message: ReturnType<typeof assistantMessage>,
) {
  const stream = new EventStream<ProviderEvent, ProviderResult>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return { message: event.message };
      throw (event as { type: "error"; error: Error }).error;
    },
  );
  if (signal) stream.attachSignal(signal);
  queueMicrotask(() => {
    stream.push({ type: "start" });
    for (const block of message.content) {
      if (block.type === "text") stream.push({ type: "text_delta", delta: block.text });
      if (block.type === "tool_call") {
        stream.push({ type: "tool_call_start", id: block.id, name: block.name });
        stream.push({ type: "tool_call_end", id: block.id, name: block.name, input: block.input });
      }
    }
    stream.push({ type: "done", stopReason: message.stopReason, message: { ...message, model } });
  });
  return stream;
}
