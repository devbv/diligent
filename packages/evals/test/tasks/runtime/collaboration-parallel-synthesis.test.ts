// @summary Real-runtime overlap, exact evidence, and mutation coverage for parallel synthesis

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EventStream } from "@diligent/core/event-stream";
import type { AssistantMessage } from "@diligent/core/message-contract";
import { resolveModel, resolveModelForClass } from "@diligent/core/model-registry";
import type { ProviderEvent, ProviderResult, StreamContext, StreamFunction } from "@diligent/core/provider-contract";
import { DEFAULT_PROFILES } from "../../../src/profiles";
import { runRuntimeEvalExecution } from "../../../src/runner/runtime-execution";
import type { RuntimeEvalExecution } from "../../../src/runtime-task";
import type { EvalProfile } from "../../../src/task";
import {
  COLLABORATION_PARALLEL_SYNTHESIS_TOOL_CALL_IDS,
  type CollaborationParallelSynthesisWorld,
  collaborationParallelSynthesisTask,
} from "../../../src/tasks/runtime/collaboration-parallel-synthesis";
import { assistantMessage, sequenceStream } from "../../helpers/fake-stream";

describe("collaboration-parallel-synthesis", () => {
  test("runs two genuinely overlapping bounded children and one ordered synthesis for both providers", async () => {
    expect(DEFAULT_PROFILES).toHaveLength(2);
    for (const profile of DEFAULT_PROFILES) {
      const execution = await assembledExecution(profile);
      expect(collaborationParallelSynthesisTask.evaluate(execution), profile.provider).toEqual({ passed: true });
      expect(execution.world.sourcePaths.every((path) => execution.world.clientPrompt.includes(path))).toBe(true);
      expect(execution.world.clientPrompt).toContain(execution.world.artifactPath);
      expect(execution.world.clientPrompt).toContain(execution.world.finalResponse);
      expect(execution.world.clientPrompt).toContain("and a trailing newline");
      expect(execution.toolCalls.map((call) => call.name).sort()).toEqual(
        [
          "spawn_agent",
          "spawn_agent",
          "read",
          "read",
          "wait",
          profile.provider === "anthropic" ? "edit" : "apply_patch",
        ].sort(),
      );
      const ids = spawnedIds(execution);
      const events = execution.turns[0]!.coreEvents.map((entry) => entry.event as Record<string, unknown>);
      const running = ids.map((id) =>
        events.findIndex(
          (event) => event.type === "collab_spawn_end" && event.callId === id && event.status === "running",
        ),
      );
      const completed = ids.map((id) =>
        events.findIndex(
          (event) => event.type === "collab_spawn_end" && event.callId === id && event.status === "completed",
        ),
      );
      expect(Math.max(...running)).toBeLessThan(Math.min(...completed));
      const childModel = resolveModelForClass(
        resolveModel({ provider: profile.provider, modelId: profile.model }),
        "lite",
      );
      for (const id of ids) {
        const calls = execution.providerCalls.filter((call) => call.sessionId === id);
        expect(calls.map((call) => call.model.modelId)).toEqual([childModel.modelId, childModel.modelId]);
        expect(calls.every((call) => call.tools.items.map(toolName).join(",") === "read")).toBe(true);
      }
    }
  });

  test("accepts generated ids, semantic briefs, same read-only role, long wait, progress blocks, and reversed reads", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!, {
      generatedIds: true,
      semanticSpawnInputs: true,
      omitSpawnNestedOption: true,
      longWait: true,
      reverseWaitIds: true,
      includeProgressText: true,
      reverseReadOrder: true,
      reverseCompletionOrder: true,
      explicitReadLimit: true,
      trailingChildReport: true,
      trailingPatchNewline: true,
    });
    const spawns = execution.toolCalls.filter((call) => call.name === "spawn_agent");
    expect(spawns).toHaveLength(2);
    expect(spawns.every((call) => (call.input as { agent_type: string }).agent_type === "explore")).toBe(true);
    expect((execution.toolCalls.find((call) => call.name === "wait")!.input as { timeout_ms: number }).timeout_ms).toBe(
      900_000,
    );
    expect(execution.toolCalls.filter((call) => call.name === "read").map((call) => call.input)).toEqual([
      { file_path: "$WORKSPACE/regions/south/coordination.fact", limit: 2000 },
      { file_path: "$WORKSPACE/regions/north/coordination.fact", limit: 2000 },
    ]);
    expect(collaborationParallelSynthesisTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("reports cross-region names in negative child instructions without confusing them with cross-region access", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!);
    const spawns = execution.toolCalls.filter((call) => call.name === "spawn_agent");
    for (const [index, spawn] of spawns.entries()) {
      const otherPath = execution.world.sourcePaths[index === 0 ? 1 : 0];
      (spawn.input as { message: string }).message += ` Do not inspect, read, mention, or infer ${otherPath}.`;
    }

    expect(collaborationParallelSynthesisTask.evaluate(execution)).toMatchObject({
      passed: true,
      diagnostics: [
        {
          impact: "info",
          code: "collaboration_parallel_synthesis.cross_region_brief_reference",
        },
      ],
    });

    const crossed = structuredClone(execution);
    const northRead = crossed.toolCalls.find(
      (call) => call.name === "read" && call.threadId === spawnedIds(crossed)[0],
    )!;
    (northRead.input as { file_path: string }).file_path = `$WORKSPACE/${crossed.world.sourcePaths[1]}`;
    expect(collaborationParallelSynthesisTask.evaluate(crossed)).toMatchObject({
      passed: false,
      dimension: "runtime_policy",
    });
  });

  test("does not gate live behavior on persistence mirrors or verifier wording", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!);
    execution.session.lines = [];
    execution.childSessions.forEach((session) => (session.lines = []));
    execution.turns[0]!.coreEvents = [];
    execution.turns[0]!.runtimeEvents = [];
    execution.turns[0]!.notifications = [];
    execution.verifier!.argv = ["deterministic-verifier"];
    execution.verifier!.stdout = "alternate success wording\n";
    execution.verifier!.stderr = "diagnostic detail\n";
    expect(collaborationParallelSynthesisTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("accepts one bounded Anthropic relative-path edit recovery and target-only child reports", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "anthropic")!;
    const execution = await assembledExecution(profile, {
      verboseChildReport: true,
      relativeEditRecovery: true,
    });
    const edits = execution.toolCalls.filter((call) => call.name === "edit");
    expect(edits).toHaveLength(2);
    expect(edits[0]!.outcome).toBe("runtime_error");
    expect(edits[1]!.outcome).toBe("success");
    expect(collaborationParallelSynthesisTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("accepts one provider-neutral child relative-read recovery for either assigned region", async () => {
    for (const [index, profile] of DEFAULT_PROFILES.entries()) {
      const recoveringRegion = index === 0 ? "north" : "south";
      const execution = await assembledExecution(profile, { relativeReadRecovery: recoveringRegion });
      const ids = spawnedIds(execution);
      const recoveringChild = ids[index];
      const directChild = ids[index === 0 ? 1 : 0];
      expect(execution.toolCalls).toHaveLength(7);
      expect(execution.providerCalls).toHaveLength(9);
      expect(
        execution.providerCalls
          .filter((call) => call.sessionId === recoveringChild)
          .map((call) => call.messages.totalCount),
      ).toEqual([1, 3, 5]);
      expect(
        execution.providerCalls
          .filter((call) => call.sessionId === directChild)
          .map((call) => call.messages.totalCount),
      ).toEqual([1, 3]);
      expect(execution.childSessions.find((child) => child.threadId === recoveringChild)?.lines).toHaveLength(7);
      expect(execution.childSessions.find((child) => child.threadId === directChild)?.lines).toHaveLength(5);
      expect(collaborationParallelSynthesisTask.evaluate(execution), profile.provider).toMatchObject({ passed: true });
    }
  });

  test("accepts independent child read and Anthropic parent edit recoveries together", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "anthropic")!;
    const execution = await assembledExecution(profile, {
      relativeReadRecovery: "north",
      relativeEditRecovery: true,
    });
    expect(execution.toolCalls).toHaveLength(8);
    expect(execution.providerCalls).toHaveLength(10);
    expect(collaborationParallelSynthesisTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("rejects malformed, misattributed, repeated, or unlinked child read recoveries", async () => {
    const baseline = await assembledExecution(DEFAULT_PROFILES[0]!, { relativeReadRecovery: "north" });
    const cases: Mutation[] = [
      [
        "relative recovery path",
        (value) => setRecoveryTraceInput(value, "file_path", "regions/south/coordination.fact"),
      ],
      ["relative recovery extra input", (value) => setRecoveryTraceInput(value, "limit", 2000)],
      ["relative recovery error", (value) => (childRecoveryTrace(value).error = "wrong")],
      ["relative recovery output", (value) => setRecoveryOutput(value, "output", "wrong")],
      ["relative recovery render", (value) => setRecoveryOutput(value, "render", { outputSummary: "wrong" })],
      ["relative recovery metadata", (value) => setRecoveryOutput(value, "metadata", { error: false })],
      ["relative recovery actor", (value) => (childRecoveryTrace(value).threadId = value.session.threadId)],
      ["relative recovery child actor", (value) => (childRecoveryTrace(value).childThreadId = value.session.threadId)],
      ["relative recovery outcome", (value) => (childRecoveryTrace(value).outcome = "policy_rejection")],
      ["relative recovery general error", (value) => mutateRecoveryErrorEverywhere(value, "Error: general failure")],
      [
        "relative recovery provider session",
        (value) => {
          const childId = childRecoveryTrace(value).threadId;
          const calls = value.providerCalls.filter((call) => call.sessionId === childId);
          calls[1]!.sessionId = value.session.threadId;
        },
      ],
      [
        "relative recovery provider adjacency",
        (value) => {
          const childId = childRecoveryTrace(value).threadId;
          const failedIndex = value.providerCalls.findIndex(
            (call) => call.sessionId === childId && call.messages.totalCount === 3,
          );
          const successIndex = value.providerCalls.findIndex(
            (call) => call.sessionId === childId && call.messages.totalCount === 5,
          );
          [value.providerCalls[failedIndex], value.providerCalls[successIndex]] = [
            value.providerCalls[successIndex]!,
            value.providerCalls[failedIndex]!,
          ];
          value.providerCalls.forEach((call, index) => (call.sequence = index + 1));
        },
      ],
      [
        "relative recovery cross-region success",
        (value) => {
          const recovery = childRecoveryTrace(value);
          const success = value.toolCalls.find(
            (call) =>
              call.name === "read" &&
              call.outcome === "success" &&
              call.threadId === recovery.threadId &&
              call.childThreadId === recovery.childThreadId,
          )!;
          (success.input as { file_path: string }).file_path = "$WORKSPACE/regions/south/coordination.fact";
        },
      ],
      [
        "relative recovery provider count",
        (value) => {
          value.providerCalls.pop();
        },
      ],
      [
        "relative recovery lifecycle count",
        (value) => {
          const turnStart = value.turns[0]!.coreEvents.findIndex(
            (entry) => (entry.event as { type?: string }).type === "turn_start",
          );
          value.turns[0]!.coreEvents.splice(turnStart, 1);
        },
      ],
      [
        "relative recovery persistence count",
        (value) => {
          const child = value.childSessions.find(
            (candidate) => candidate.threadId === childRecoveryTrace(value).threadId,
          )!;
          child.lines.pop();
        },
      ],
      [
        "provider changed around recovery",
        (value) => {
          const childId = childRecoveryTrace(value).threadId;
          value.providerCalls.find((call) => call.sessionId === childId)!.model.provider = "anthropic";
        },
      ],
    ];
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      const before = JSON.stringify(changed);
      mutate(changed);
      expect(JSON.stringify(changed), `${label} must change evidence`).not.toBe(before);
      const result = collaborationParallelSynthesisTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
    const repeated = await assembledExecution(DEFAULT_PROFILES[0]!, { relativeReadRecovery: "both" });
    expect(collaborationParallelSynthesisTask.evaluate(repeated), "bounded child recoveries").toMatchObject({
      passed: true,
      diagnostics: [{ code: "collaboration_parallel_synthesis.bounded_recovery" }],
    });
  });

  test("rejects at least 140 independently no-op-guarded mutations across exact evidence surfaces", async () => {
    const baseline = await assembledExecution(DEFAULT_PROFILES[0]!);
    expect(collaborationParallelSynthesisTask.evaluate(baseline)).toEqual({ passed: true });
    const cases = mutationCases(baseline);
    expect(cases.length).toBeGreaterThanOrEqual(140);
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      const before = JSON.stringify(changed);
      mutate(changed);
      expect(JSON.stringify(changed), `${label} must change evidence`).not.toBe(before);
      const result = collaborationParallelSynthesisTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
  });

  test("rejects coupled self-consistent mutations through independent reconstruction", async () => {
    const baseline = await assembledExecution(DEFAULT_PROFILES[0]!);
    const ids = spawnedIds(baseline);
    const cases: Mutation[] = [
      ["all child ids", (value) => mutateAllChildIds(value, ids, ["coupled-north", "coupled-south"])],
      [
        "all child models",
        (value) => {
          for (const call of value.providerCalls.filter((candidate) => ids.includes(candidate.sessionId ?? ""))) {
            call.model.modelId = "coupled-lite-model";
          }
        },
      ],
      [
        "all child efforts",
        (value) => {
          for (const call of value.providerCalls.filter((candidate) => ids.includes(candidate.sessionId ?? ""))) {
            call.streamOptions.effort = "high";
          }
        },
      ],
      ["both assignments and cross reads", swapAssignmentsEverywhere],
      ["wait result all surfaces", (value) => replaceEverySubstring(value, value.world.tokens[0], "COUPLED_WAIT")],
      ["artifact facts all surfaces", (value) => replaceEverySubstring(value, value.world.tokens[0], "COUPLED_FACT")],
      ["artifact order all surfaces", swapFactsEverywhere],
      ["lifecycle actors all mirrors", mutateLifecycleActors],
      [
        "persisted final all surfaces",
        (value) => replaceEveryExactText(value, value.world.finalResponse, "WRONG_FINAL"),
      ],
    ];
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      const before = JSON.stringify(changed);
      mutate(changed);
      expect(JSON.stringify(changed), `${label} must change evidence`).not.toBe(before);
      const result = collaborationParallelSynthesisTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
  });

  test("rejects focused Anthropic native edit mutations with no-op guards", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "anthropic")!;
    const baseline = await assembledExecution(profile);
    const write = () =>
      baseline.toolCalls.find((call) => call.toolCallId === COLLABORATION_PARALLEL_SYNTHESIS_TOOL_CALL_IDS.write)!;
    expect(write().name).toBe("edit");
    const cases: Mutation[] = [
      ["edit path", (value) => setWriteInput(value, "file_path", "wrong")],
      ["edit old", (value) => setWriteInput(value, "old_string", "wrong")],
      ["edit new", (value) => setWriteInput(value, "new_string", "wrong")],
      ["edit replace", (value) => setWriteInput(value, "replace_all", true)],
      ["edit output", (value) => setWriteOutput(value, "output", "wrong")],
      ["edit images", (value) => setWriteOutput(value, "outputImages", [])],
      ["edit render input", (value) => setWriteRender(value, "inputSummary", "wrong")],
      ["edit render output", (value) => setWriteRender(value, "outputSummary", "wrong")],
      ["edit render blocks", (value) => setWriteRender(value, "blocks", [])],
    ];
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      const before = JSON.stringify(changed);
      mutate(changed);
      expect(JSON.stringify(changed), `${label} must change evidence`).not.toBe(before);
      const result = collaborationParallelSynthesisTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
  });
});

interface AssembledExecutionOptions {
  generatedIds?: boolean;
  semanticSpawnInputs?: boolean;
  omitSpawnNestedOption?: boolean;
  longWait?: boolean;
  reverseWaitIds?: boolean;
  includeProgressText?: boolean;
  reverseReadOrder?: boolean;
  reverseCompletionOrder?: boolean;
  explicitReadLimit?: boolean;
  trailingChildReport?: boolean;
  fencedChildReport?: boolean;
  verboseChildReport?: boolean;
  relativeReadRecovery?: "north" | "south" | "both";
  relativeEditRecovery?: boolean;
  trailingPatchNewline?: boolean;
}

async function assembledExecution(
  profile: EvalProfile,
  assembledOptions: AssembledExecutionOptions = {},
): Promise<RuntimeEvalExecution<CollaborationParallelSynthesisWorld>> {
  const seed = "shared-seed-123";
  const result = await runRuntimeEvalExecution({
    task: collaborationParallelSynthesisTask,
    seed,
    profile,
    streamFunction: fixtureStream(profile, seed, assembledOptions),
  });
  if (!Object.values(assembledOptions).some(Boolean)) {
    expect(
      result.failures,
      JSON.stringify({
        failures: result.failures,
        providerCalls: result.execution.providerCalls,
        toolCalls: result.execution.toolCalls,
        events: result.execution.turns[0]?.coreEvents,
        session: result.execution.session,
        childSessions: result.execution.childSessions,
        threadReads: result.execution.threadReads,
        workspace: result.execution.workspace,
      }),
    ).toEqual([]);
  }
  return result.execution as RuntimeEvalExecution<CollaborationParallelSynthesisWorld>;
}

function fixtureStream(
  profile: EvalProfile,
  seed: string,
  assembledOptions: AssembledExecutionOptions,
): StreamFunction {
  let parentCall = 0;
  const childCalls = [0, 0];
  const tokens = [seeded(seed, "NORTH_FACT"), seeded(seed, "SOUTH_FACT")];
  const callIds = assembledOptions.generatedIds
    ? {
        spawnNorth: "runtime-spawn-north",
        spawnSouth: "runtime-spawn-south",
        readNorth: "runtime-read-north",
        readSouth: "runtime-read-south",
        wait: "runtime-wait",
        write: "runtime-write",
      }
    : COLLABORATION_PARALLEL_SYNTHESIS_TOOL_CALL_IDS;
  return (model, context, options) => {
    const childIndex = regionIndex(context);
    if (childIndex !== undefined) {
      const call = ++childCalls[childIndex];
      const recovering =
        assembledOptions.relativeReadRecovery === "both" ||
        assembledOptions.relativeReadRecovery === (childIndex === 0 ? "north" : "south");
      const isReadCall = call === 1 || (recovering && call === 2);
      const isFailedRelativeRead = recovering && call === 1;
      const response = isReadCall
        ? assistantMessage(
            [
              {
                type: "tool_call",
                id: isFailedRelativeRead
                  ? `${childIndex === 0 ? callIds.readNorth : callIds.readSouth}-relative`
                  : childIndex === 0
                    ? callIds.readNorth
                    : callIds.readSouth,
                name: "read",
                input: {
                  file_path: isFailedRelativeRead
                    ? childIndex === 0
                      ? "regions/north/coordination.fact"
                      : "regions/south/coordination.fact"
                    : join(
                        cwdFromContext(context, "runtime_context"),
                        childIndex === 0 ? "regions/north/coordination.fact" : "regions/south/coordination.fact",
                      ),
                  ...(assembledOptions.explicitReadLimit ? { limit: 2000 } : {}),
                },
              },
            ],
            "tool_use",
          )
        : assistantMessage([
            {
              type: "text",
              text: assembledOptions.verboseChildReport
                ? `Here is the exact file content:\n\n\`\`\`\n${tokens[childIndex]}\n\`\`\`\n\nThe file contains "${tokens[childIndex]}" followed by a newline.`
                : assembledOptions.fencedChildReport
                  ? `\`\`\`\n${tokens[childIndex]}${childIndex === 0 ? "\n" : ""}\n\`\`\``
                  : assembledOptions.trailingChildReport && childIndex === 1
                    ? `${tokens[childIndex]}\n`
                    : tokens[childIndex]!,
            },
          ]);
      const readDelay = assembledOptions.reverseReadOrder ? (childIndex === 0 ? 25 : 15) : 15 + childIndex * 10;
      const completionDelay = assembledOptions.reverseCompletionOrder
        ? childIndex === 0
          ? 55
          : 45
        : 45 + childIndex * 10;
      return delayedMessage(response, model, options.signal, isReadCall ? readDelay + call * 2 : completionDelay);
    }
    return sequenceStream([parentResponse(++parentCall, profile, context, tokens, callIds, assembledOptions)])(
      model,
      context,
      options,
    );
  };
}

function parentResponse(
  call: number,
  profile: EvalProfile,
  context: StreamContext,
  tokens: string[],
  callIds: Record<keyof typeof COLLABORATION_PARALLEL_SYNTHESIS_TOOL_CALL_IDS, string>,
  assembledOptions: AssembledExecutionOptions,
) {
  if (call === 1)
    return assistantMessage(
      [
        ...(assembledOptions.includeProgressText
          ? [{ type: "text" as const, text: "I will run both regional lookups concurrently." }]
          : []),
        {
          type: "tool_call",
          id: callIds.spawnNorth,
          name: "spawn_agent",
          input: {
            message: assembledOptions.semanticSpawnInputs
              ? "Retrieve the exact contents of regions/north/coordination.fact by reading it exactly once. Do not inspect any other region and return only the contents."
              : "Read only regions/north/coordination.fact exactly once. Return only its exact token, without commentary or a trailing newline. Do not inspect any other region.",
            description: assembledOptions.semanticSpawnInputs
              ? "Retrieve north token"
              : "Retrieve northern coordination fact",
            agent_type: "explore",
            ...(!assembledOptions.omitSpawnNestedOption ? { allow_nested_agents: false } : {}),
          },
        },
        {
          type: "tool_call",
          id: callIds.spawnSouth,
          name: "spawn_agent",
          input: {
            message: assembledOptions.semanticSpawnInputs
              ? "Retrieve the exact contents of regions/south/coordination.fact by reading it exactly once. Do not inspect any other region and return only the contents."
              : "Read only regions/south/coordination.fact exactly once. Return only its exact token, without commentary or a trailing newline. Do not inspect any other region.",
            description: assembledOptions.semanticSpawnInputs
              ? "Retrieve south token"
              : "Retrieve southern coordination fact",
            agent_type: "explore",
            ...(!assembledOptions.omitSpawnNestedOption ? { allow_nested_agents: false } : {}),
          },
        },
      ],
      "tool_use",
    );
  if (call === 2)
    return assistantMessage(
      [
        {
          type: "tool_call",
          id: callIds.wait,
          name: "wait",
          input: {
            ids: assembledOptions.reverseWaitIds ? spawnedThreadIds(context).toReversed() : spawnedThreadIds(context),
            timeout_ms: assembledOptions.longWait ? 900_000 : 30_000,
          },
        },
      ],
      "tool_use",
    );
  if (call === 3 && assembledOptions.relativeEditRecovery)
    return assistantMessage(
      [
        {
          type: "tool_call",
          id: `${callIds.write}-relative`,
          name: "edit",
          input: {
            file_path: "parallel-synthesis.txt",
            old_string: "",
            new_string: `${tokens[0]}\n${tokens[1]}\n`,
          },
        },
      ],
      "tool_use",
    );
  if (call === 3 || (call === 4 && assembledOptions.relativeEditRecovery))
    return assistantMessage(
      [
        {
          type: "tool_call",
          id: callIds.write,
          name: profile.provider === "anthropic" ? "edit" : "apply_patch",
          input:
            profile.provider === "anthropic"
              ? {
                  file_path: join(cwdFromContext(context, "base"), "parallel-synthesis.txt"),
                  old_string: "",
                  new_string: `${tokens[0]}\n${tokens[1]}\n`,
                  replace_all: false,
                }
              : {
                  patch: `*** Begin Patch\n*** Add File: parallel-synthesis.txt\n+${tokens[0]}\n+${tokens[1]}\n*** End Patch${assembledOptions.trailingPatchNewline ? "\n" : ""}`,
                },
        },
      ],
      "tool_use",
    );
  return assistantMessage([{ type: "text", text: "PARALLEL_SYNTHESIS_RECORDED" }]);
}

function delayedMessage(
  message: AssistantMessage,
  model: Parameters<StreamFunction>[0],
  signal: AbortSignal | undefined,
  delayMs: number,
) {
  const stream = new EventStream<ProviderEvent, ProviderResult>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return { message: event.message };
      throw (event as { type: "error"; error: Error }).error;
    },
  );
  if (signal) stream.attachSignal(signal);
  setTimeout(() => {
    const resolved = { ...message, model };
    stream.push({ type: "start" });
    for (const block of resolved.content) {
      if (block.type !== "tool_call") continue;
      stream.push({ type: "tool_call_start", id: block.id, name: block.name });
      stream.push({ type: "tool_call_end", id: block.id, name: block.name, input: block.input });
    }
    stream.push({ type: "done", stopReason: resolved.stopReason, message: resolved });
  }, delayMs);
  return stream;
}

function regionIndex(context: StreamContext): number | undefined {
  if (!context.systemPrompt.some((section) => section.label === "agent_role")) return undefined;
  const messages = JSON.stringify(context.messages);
  if (messages.includes("regions/north/coordination.fact")) return 0;
  if (messages.includes("regions/south/coordination.fact")) return 1;
  return undefined;
}

function cwdFromContext(context: StreamContext, label: "base" | "runtime_context"): string {
  const content = context.systemPrompt.find((section) => section.label === label)?.content ?? "";
  const match = content.match(/^Current working directory: (.+)$/m);
  if (!match?.[1]) throw new Error(`Missing ${label} cwd in provider context.`);
  return match[1];
}

function spawnedThreadIds(context: StreamContext): [string, string] {
  const ids = [...JSON.stringify(context.messages).matchAll(/\\"thread_id\\":\\"([^\\"]+)\\"/g)].map(
    (match) => match[1]!,
  );
  if (ids.length !== 2 || ids[0] === ids[1]) throw new Error("Missing two distinct spawned child thread ids.");
  return [ids[0]!, ids[1]!];
}

function spawnedIds(execution: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>): [string, string] {
  const result = [
    COLLABORATION_PARALLEL_SYNTHESIS_TOOL_CALL_IDS.spawnNorth,
    COLLABORATION_PARALLEL_SYNTHESIS_TOOL_CALL_IDS.spawnSouth,
  ].map((id) => {
    const trace = execution.toolCalls.find((call) => call.toolCallId === id)!;
    return JSON.parse((trace.output as { output: string }).output).thread_id as string;
  });
  return [result[0]!, result[1]!];
}

function seeded(seed: string, prefix: string): string {
  return `${prefix}_${seed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "seed"}`;
}

type Mutation = [string, (value: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>) => void];

function mutationCases(baseline: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>): Mutation[] {
  const cases: Mutation[] = [
    ["task id", (value) => (value.taskId = "wrong")],
    ["seed", (value) => (value.seed = "wrong")],
    ["world root", (value) => (value.world.root = "wrong")],
    ["world seed", (value) => (value.world.seed = "wrong")],
    ["world expected", (value) => (value.world.expected = "wrong")],
    ["north token", (value) => (value.world.tokens[0] = "wrong")],
    ["south token", (value) => (value.world.tokens[1] = "wrong")],
    ["north path", (value) => (value.world.sourcePaths[0] = "wrong")],
    ["south path", (value) => (value.world.sourcePaths[1] = "wrong")],
    ["north hash", (value) => (value.world.sourceHashes[0] = "wrong")],
    ["south hash", (value) => (value.world.sourceHashes[1] = "wrong")],
    ["artifact path", (value) => (value.world.artifactPath = "wrong")],
    ["client prompt", (value) => (value.world.clientPrompt += " wrong")],
    ["north brief", (value) => (value.world.workerBriefs[0] += " wrong")],
    ["south brief", (value) => (value.world.workerBriefs[1] += " wrong")],
    ["final response world", (value) => (value.world.finalResponse = "wrong")],
    ["expected hash", (value) => (value.world.expectedHash = "wrong")],
    ["protected path", (value) => value.world.protectedPaths.pop()],
    ["allowed change", (value) => value.world.allowedChanges.push("wrong")],
    ["runtime config missing", (value) => value.world.runtimeConfigs.pop()],
    ["runtime disabled", (value) => (value.world.runtimeConfigs[0]!.agentsEnabled = false)],
    ["runtime names", (value) => value.world.runtimeConfigs[0]!.builtinNames.reverse()],
    ["termination", (value) => (value.termination = "runtime_error")],
    ["execution error", (value) => (value.error = { name: "Error", message: "wrong" })],
    ["extra turn", (value) => value.turns.push(structuredClone(value.turns[0]!))],
    ["turn index", (value) => (value.turns[0]!.index = 1)],
    ["turn termination", (value) => (value.turns[0]!.termination = "failed")],
    ["turn thread", (value) => (value.turns[0]!.threadId = "wrong")],
    ["turn prompt", (value) => (value.turns[0]!.clientPrompt += " wrong")],
    ["thread cwd", (value) => (value.threadCwd = "wrong")],
    ["thread read missing", (value) => value.threadReads.pop()],
    ["thread phase", (value) => (value.threadReads[0]!.phase = "after_resume")],
    ["thread index", (value) => (value.threadReads[0]!.turnIndex = 1)],
    ["thread response cwd", (value) => (value.threadReads[0]!.response.cwd = "wrong")],
    ["thread running", (value) => (value.threadReads[0]!.response.isRunning = true)],
    ["thread mode", (value) => (value.threadReads[0]!.response.currentMode = "plan")],
    ["thread effort", (value) => (value.threadReads[0]!.response.currentEffort = "low")],
    ["thread model", (value) => (value.threadReads[0]!.response.currentModel!.modelId = "wrong")],
    ["advertised missing", (value) => value.advertisedTools.pop()],
    ["advertised sequence", (value) => (value.advertisedTools[0]!.sequence = 99)],
    ["advertised mode", (value) => (value.advertisedTools[0]!.mode = "plan")],
    [
      "advertised provider",
      (value) =>
        (value.advertisedTools[0]!.provider =
          value.advertisedTools[0]!.provider === "anthropic" ? "openai" : "anthropic"),
    ],
    ["advertised cwd", (value) => (value.advertisedTools[0]!.cwd = "wrong")],
    ["advertised duplicate tool", (value) => value.advertisedTools[0]!.tools.push("read")],
    ["advertised extra snapshot", (value) => value.advertisedTools.push(structuredClone(value.advertisedTools[0]!))],
    ["root session", (value) => (value.session.threadId = "wrong")],
    ["root lines", (value) => value.session.lines.pop()],
    ["child missing", (value) => value.childSessions.pop()],
    ["child extra", (value) => value.childSessions.push(structuredClone(value.childSessions[0]!))],
    ["child header", (value) => ((value.childSessions[0]!.lines[0] as Record<string, unknown>).cwd = "wrong")],
    ["child lines", (value) => value.childSessions[0]!.lines.pop()],
    ["compaction", (value) => value.compactions.push({} as never)],
    ["protocol action", (value) => value.protocolActions.push({} as never)],
    ["approval", (value) => value.approvals.push({})],
    ["user input", (value) => value.userInputRequests.push({})],
    ["tool output", (value) => value.toolOutputFiles.push({ path: "wrong", bytes: 1, sha256: "wrong" })],
    ["log", (value) => value.logs.push({ level: "info", message: "wrong" } as never)],
    ["runtime state", (value) => value.runtimeState.diff.push({ path: "wrong", category: "other", change: "added" })],
    [
      "runtime state allowed-category injection",
      (value) =>
        value.runtimeState.diff.push({ path: ".diligent/sessions/ghost.jsonl", category: "sessions", change: "added" }),
    ],
    ["verifier missing", (value) => (value.verifier = undefined)],
    ["verifier argv", (value) => value.verifier!.argv.push("wrong")],
    ["verifier exit", (value) => (value.verifier!.exitCode = 1)],
    ["verifier timeout", (value) => (value.verifier!.timedOut = true)],
    ["verifier stdout", (value) => (value.verifier!.stdout = "wrong")],
    ["verifier stderr", (value) => (value.verifier!.stderr = "wrong")],
    ["workspace initial", (value) => value.workspace.initial.entries.pop()],
    ["workspace final", (value) => value.workspace.final.entries.pop()],
    ["workspace extra", (value) => value.workspace.final.entries.push({ path: "wrong", kind: "file", size: 1 })],
    ["core event", (value) => value.turns[0]!.coreEvents.pop()],
    ["runtime event", (value) => value.turns[0]!.runtimeEvents.pop()],
    [
      "notification event",
      (value) => {
        const index = value.turns[0]!.notifications.findIndex((notice) => notice.method === "agent/event");
        value.turns[0]!.notifications.splice(index, 1);
      },
    ],
    ["event sequence", (value) => (value.turns[0]!.coreEvents[0]!.sequence = 99)],
    ["final output", (value) => setFinal(value, "wrong")],
    ["final leak north", (value) => setFinal(value, value.world.tokens[0])],
    ["final leak south", (value) => setFinal(value, value.world.tokens[1])],
  ];
  for (let index = 0; index < baseline.providerCalls.length; index += 1) {
    cases.push(
      [`provider ${index} sequence`, (value) => (value.providerCalls[index]!.sequence = 99)],
      [`provider ${index} session`, (value) => (value.providerCalls[index]!.sessionId = "wrong")],
      [`provider ${index} model`, (value) => (value.providerCalls[index]!.model.modelId = "wrong")],
      [`provider ${index} effort`, (value) => (value.providerCalls[index]!.streamOptions.effort = "wrong")],
      [`provider ${index} max tokens`, (value) => (value.providerCalls[index]!.streamOptions.maxTokens = 1)],
      [`provider ${index} bounds`, (value) => (value.providerCalls[index]!.bounds.maxDepth += 1)],
      [`provider ${index} messages`, (value) => (value.providerCalls[index]!.messages.totalCount += 1)],
      [
        `provider ${index} tool`,
        (value) => ((value.providerCalls[index]!.tools.items[0] as { name: string }).name = "wrong"),
      ],
    );
  }
  for (let index = 0; index < baseline.toolCalls.length; index += 1) {
    cases.push(
      [`trace ${index} sequence`, (value) => (value.toolCalls[index]!.sequence = 99)],
      [`trace ${index} id`, (value) => (value.toolCalls[index]!.toolCallId = `wrong-${index}`)],
      [`trace ${index} name`, (value) => (value.toolCalls[index]!.name = "wrong")],
      [`trace ${index} actor`, (value) => (value.toolCalls[index]!.threadId = "wrong")],
      [`trace ${index} child actor`, (value) => (value.toolCalls[index]!.childThreadId = "wrong")],
      [`trace ${index} capability`, (value) => (value.toolCalls[index]!.capability = "execute")],
      [`trace ${index} outcome`, (value) => (value.toolCalls[index]!.outcome = "runtime_error")],
      [`trace ${index} input`, (value) => (value.toolCalls[index]!.input = { wrong: true })],
      [`trace ${index} output`, (value) => (value.toolCalls[index]!.output = { output: "wrong" })],
    );
  }
  return cases;
}

function setWriteInput(
  value: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>,
  key: string,
  replacement: unknown,
) {
  const trace = value.toolCalls.find(
    (call) => call.toolCallId === COLLABORATION_PARALLEL_SYNTHESIS_TOOL_CALL_IDS.write,
  )!;
  (trace.input as Record<string, unknown>)[key] = replacement;
}

function setWriteOutput(
  value: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>,
  key: string,
  replacement: unknown,
) {
  const trace = value.toolCalls.find(
    (call) => call.toolCallId === COLLABORATION_PARALLEL_SYNTHESIS_TOOL_CALL_IDS.write,
  )!;
  (trace.output as Record<string, unknown>)[key] = replacement;
}

function setWriteRender(
  value: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>,
  key: string,
  replacement: unknown,
) {
  const trace = value.toolCalls.find(
    (call) => call.toolCallId === COLLABORATION_PARALLEL_SYNTHESIS_TOOL_CALL_IDS.write,
  )!;
  (((trace.output as Record<string, unknown>).render as Record<string, unknown>)[key] as unknown) = replacement;
}

function childRecoveryTrace(value: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>) {
  const matches = value.toolCalls.filter(
    (call) => call.name === "read" && call.outcome !== "success" && typeof call.error === "string",
  );
  if (matches.length !== 1) throw new Error(`Expected one child read recovery, received ${matches.length}.`);
  return matches[0]!;
}

function setRecoveryTraceInput(
  value: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>,
  key: string,
  replacement: unknown,
) {
  (childRecoveryTrace(value).input as Record<string, unknown>)[key] = replacement;
}

function setRecoveryOutput(
  value: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>,
  key: string,
  replacement: unknown,
) {
  (childRecoveryTrace(value).output as Record<string, unknown>)[key] = replacement;
}

function mutateRecoveryErrorEverywhere(
  value: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>,
  replacement: string,
) {
  const recovery = childRecoveryTrace(value);
  replaceEverySubstring(value, recovery.error!, replacement);
}

function mutateAllChildIds(
  value: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>,
  oldIds: [string, string],
  newIds: [string, string],
) {
  replaceEverySubstring(value, oldIds[0], newIds[0]);
  replaceEverySubstring(value, oldIds[1], newIds[1]);
}

function swapAssignmentsEverywhere(value: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>) {
  swapSubstring(value, "regions/north/coordination.fact", "regions/south/coordination.fact");
  swapSubstring(value, value.world.tokens[0], value.world.tokens[1]);
}

function swapFactsEverywhere(value: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>) {
  swapSubstring(value, value.world.tokens[0], value.world.tokens[1]);
}

function mutateLifecycleActors(value: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>) {
  for (const collection of [
    value.turns[0]!.coreEvents.map((entry) => entry.event),
    value.turns[0]!.runtimeEvents,
    value.turns[0]!.notifications.filter((notice) => notice.method === "agent/event").map(
      (notice) => (notice.params as { event: unknown }).event,
    ),
  ]) {
    for (const event of collection) {
      const record = event as Record<string, unknown>;
      if (record.agentType === "explore") record.agentType = "general";
      else if (record.agentType === "general") record.agentType = "explore";
    }
  }
}

function swapSubstring(value: unknown, left: string, right: string) {
  replaceEverySubstring(value, left, "__EVAL_SWAP_SENTINEL__");
  replaceEverySubstring(value, right, left);
  replaceEverySubstring(value, "__EVAL_SWAP_SENTINEL__", right);
}

function replaceEverySubstring(value: unknown, expected: string, replacement: string): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === "string") value[index] = value[index].replaceAll(expected, replacement);
      else replaceEverySubstring(value[index], expected, replacement);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") (value as Record<string, unknown>)[key] = child.replaceAll(expected, replacement);
    else replaceEverySubstring(child, expected, replacement);
  }
}

function replaceEveryExactText(value: unknown, expected: string, replacement: string): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === expected) value[index] = replacement;
      else replaceEveryExactText(value[index], expected, replacement);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (child === expected) (value as Record<string, unknown>)[key] = replacement;
    else replaceEveryExactText(child, expected, replacement);
  }
}

function setFinal(value: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>, text: string) {
  const final = value.turns[0]!.messages.at(-1);
  if (!final || final.role !== "assistant") throw new Error("Missing final assistant response.");
  final.content = [{ type: "text", text }];
}

function toolName(value: unknown) {
  return (value as { name?: string }).name;
}
