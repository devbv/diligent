// @summary Real-runtime resume-reference identity and mutation coverage

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveModel, resolveModelForClass } from "@diligent/core/model-registry";
import type { StreamContext, StreamFunction } from "@diligent/core/provider-contract";
import { DEFAULT_PROFILES } from "../../../src/profiles";
import { runRuntimeEvalExecution } from "../../../src/runner/runtime-execution";
import type { RuntimeEvalExecution } from "../../../src/runtime-task";
import type { EvalProfile } from "../../../src/task";
import {
  COLLABORATION_RESUME_REFERENCE_TOOL_CALL_IDS,
  type CollaborationResumeReferenceWorld,
  collaborationResumeReferenceTask,
} from "../../../src/tasks/runtime/collaboration-resume-reference";
import { assistantMessage, sequenceStream } from "../../helpers/fake-stream";

describe("collaboration-resume-reference", () => {
  test("restarts and resumes the same persisted read-only child for both providers", async () => {
    expect(DEFAULT_PROFILES).toHaveLength(2);
    for (const profile of DEFAULT_PROFILES) {
      const execution = await assembledExecution(profile);
      expect(collaborationResumeReferenceTask.evaluate(execution), profile.provider).toMatchObject({ passed: true });
      expect(execution.world.prompts[0]).toContain(execution.world.sourcePaths[0]);
      expect(execution.world.prompts[0]).toContain(
        `absolute file_path ending in \`/${execution.world.sourcePaths[0]}\``,
      );
      expect(execution.world.prompts[0]).toContain(execution.world.acknowledgement);
      expect(execution.world.prompts[1]).toContain(execution.world.sourcePaths[1]);
      expect(execution.world.prompts[1]).toContain(
        `absolute file_path ending in \`/${execution.world.sourcePaths[1]}\``,
      );
      expect(execution.world.prompts[1]).toContain(execution.world.artifactPath);
      expect(execution.world.prompts[1]).toContain(execution.world.finalResponse);
      expect(execution.world.prompts[1]).toContain("final newline");
      expect(execution.childSessions).toHaveLength(1);
      expect(execution.toolCalls.map((call) => call.name).sort()).toEqual(
        [
          "spawn_agent",
          "read",
          "wait",
          "spawn_agent",
          "read",
          "wait",
          profile.provider === "anthropic" ? "edit" : "apply_patch",
        ].sort(),
      );
      const id = childId(execution);
      const childModel = resolveModelForClass(
        resolveModel({ provider: profile.provider, modelId: profile.model }),
        "lite",
      );
      expect(execution.providerCalls.filter((call) => call.sessionId === id).map((call) => call.model.modelId)).toEqual(
        [childModel.modelId, childModel.modelId, childModel.modelId, childModel.modelId],
      );
    }
  });

  test("accepts dynamic ids, semantic resume briefs, optional defaults, long waits, and provider progress", async () => {
    for (const profile of DEFAULT_PROFILES) {
      const execution = await assembledExecution(profile, {
        generatedIds: true,
        semanticSpawnInputs: true,
        omitSpawnOptionalDefaults: true,
        omitResumeAgentType: true,
        longWait: true,
        includeProviderProgress: true,
        explicitReadDefaults: true,
        trailingChildReport: true,
        inlineInitialChildReport: profile.provider === "openai",
        verboseInitialChildReport: profile.provider === "anthropic",
        trailingPatchNewline: true,
        omitEditReplaceAll: true,
        anthropicWriteRecovery: profile.provider === "anthropic",
      });
      const spawns = execution.toolCalls.filter((call) => call.name === "spawn_agent");
      const id = childId(execution);
      expect(spawns).toHaveLength(2);
      expect(spawns[0]!.toolCallId).not.toBe(COLLABORATION_RESUME_REFERENCE_TOOL_CALL_IDS.spawnInitial);
      expect((spawns[1]!.input as { resume_id: string }).resume_id).toBe(id);
      expect((spawns[0]!.input as { agent_type: string }).agent_type).toBe("explore");
      expect((spawns[1]!.input as { agent_type?: string }).agent_type).toBeUndefined();
      expect(
        spawns.every((spawn) => {
          const input = spawn.input as Record<string, unknown>;
          return !("description" in input) && !("model_class" in input) && !("allowed_tools" in input);
        }),
      ).toBe(true);
      expect(
        execution.toolCalls
          .filter((call) => call.name === "wait")
          .every((call) => (call.input as { timeout_ms: number }).timeout_ms === 900_000),
      ).toBe(true);
      if (profile.provider === "anthropic") {
        const edits = execution.toolCalls.filter((call) => call.name === "edit");
        expect(edits).toHaveLength(2);
        expect(edits.map((edit) => edit.outcome)).toEqual(["runtime_error", "success"]);
      }
      expect(collaborationResumeReferenceTask.evaluate(execution), profile.provider).toMatchObject({
        passed: true,
      });

      const incompatibleResumeType = structuredClone(execution);
      const resumeSpawn = incompatibleResumeType.toolCalls.find(
        (call) => call.name === "spawn_agent" && "resume_id" in (call.input as Record<string, unknown>),
      )!;
      (resumeSpawn.input as Record<string, unknown>).agent_type = "build";
      expect(collaborationResumeReferenceTask.evaluate(incompatibleResumeType), profile.provider).toMatchObject({
        passed: false,
        code: "collaboration_resume_reference.spawn_contract",
      });
    }
  });

  test("accepts a private initial acknowledgement followed by one resumed report containing both facts", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "openai")!;
    const execution = await assembledExecution(profile, { deferredCombinedChildReport: true });
    expect(collaborationResumeReferenceTask.evaluate(execution)).toEqual({ passed: true });

    const missingFollowUp = structuredClone(execution);
    const finalChildMessage = missingFollowUp.childSessions[0]!.lines.filter(
      (line) => (line as { type?: string }).type === "message",
    )
      .map(
        (line) => (line as { message?: { role?: string; content?: Array<{ type: string; text?: string }> } }).message,
      )
      .filter((message) => message?.role === "assistant" && message.content?.some((block) => block.type === "text"))
      .at(-1)!;
    finalChildMessage.content!.find((block) => block.type === "text")!.text = execution.world.tokens[0];
    expect(collaborationResumeReferenceTask.evaluate(missingFollowUp)).toMatchObject({ passed: true });
  });

  test("accepts bounded acknowledgement prose only when it does not reveal either fixture value", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!);
    const acknowledgement = execution.turns[0]!.messages.at(-1)!;
    if (acknowledgement.role !== "assistant") throw new Error("Expected assistant acknowledgement.");
    const text = acknowledgement.content.find((block) => block.type === "text")!;
    if (text.type !== "text") throw new Error("Expected acknowledgement text.");
    text.text = `I've retained the value internally.\n\n${execution.world.acknowledgement}`;
    expect(collaborationResumeReferenceTask.evaluate(execution)).toEqual({ passed: true });

    text.text = `${execution.world.tokens[0]}\n${execution.world.acknowledgement}`;
    expect(collaborationResumeReferenceTask.evaluate(execution)).toMatchObject({
      passed: false,
      code: "collaboration_resume_reference.final",
    });
  });

  test("accepts one relative-path failure before each successful absolute child read", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!, { generatedIds: true });
    for (const sourcePath of execution.world.sourcePaths) {
      const successIndex = execution.toolCalls.findIndex(
        (call) =>
          call.name === "read" &&
          call.outcome === "success" &&
          (call.input as { file_path?: string }).file_path?.endsWith(`/${sourcePath}`),
      );
      const recovery = structuredClone(execution.toolCalls[successIndex]!);
      recovery.toolCallId = `${recovery.toolCallId}-relative-error`;
      recovery.input = { file_path: sourcePath };
      recovery.outcome = "runtime_error";
      recovery.error = `Error: file_path must be absolute: ${sourcePath}`;
      execution.toolCalls.splice(successIndex, 0, recovery);
    }
    execution.toolCalls.forEach((call, index) => (call.sequence = index + 1));

    expect(collaborationResumeReferenceTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("does not gate resume behavior on persisted transcript shape or verifier wording", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!);
    execution.session.lines = [];
    execution.childSessions[0]!.lines = [];
    execution.threadReads = [];
    execution.turns.forEach((turn) => {
      turn.coreEvents = [];
      turn.runtimeEvents = [];
      turn.notifications = [];
    });
    execution.verifier!.argv = ["deterministic-verifier"];
    execution.verifier!.stdout = "alternate success wording\n";
    expect(collaborationResumeReferenceTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("rejects malformed or broadened Anthropic absent-file recovery evidence", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "anthropic")!;
    const baseline = await assembledExecution(profile, {
      anthropicWriteRecovery: true,
      omitEditReplaceAll: true,
    });
    expect(collaborationResumeReferenceTask.evaluate(baseline)).toMatchObject({ passed: true });
    const cases: Mutation[] = [
      ["relative recovery path", (value) => (failedEditInput(value).file_path = value.world.artifactPath)],
      ["different recovery sentinel", (value) => (failedEditInput(value).old_string = "wrong")],
      ["different recovery content", (value) => (failedEditInput(value).new_string = "wrong")],
      ["replace all recovery", (value) => (failedEditInput(value).replace_all = true)],
      ["extra recovery input", (value) => (failedEditInput(value).extra = true)],
      ["different recovery outcome", (value) => (failedEdit(value).outcome = "policy_rejection")],
      ["different recovery error", (value) => (failedEdit(value).error = "wrong")],
      [
        "different recovery output",
        (value) => (((failedEdit(value).output as { output: string }).output as string) = "wrong"),
      ],
      [
        "different recovery metadata",
        (value) => ((failedEdit(value).output as { metadata: { error: boolean } }).metadata.error = false),
      ],
      ["child-attributed recovery", (value) => (failedEdit(value).childThreadId = childId(value))],
      ["non-adjacent recovery", (value) => (failedEdit(value).sequence -= 1)],
      ["extra edit attempt", appendExtraEdit],
    ];
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      const before = JSON.stringify(changed);
      mutate(changed);
      expect(JSON.stringify(changed), `${label} must change evidence`).not.toBe(before);
      const result = collaborationResumeReferenceTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
  });

  test("rejects at least 160 independently no-op-guarded evidence mutations", async () => {
    const baseline = await assembledExecution(DEFAULT_PROFILES[0]!);
    expect(collaborationResumeReferenceTask.evaluate(baseline)).toEqual({ passed: true });
    const cases = mutationCases(baseline);
    expect(cases.length).toBeGreaterThanOrEqual(160);
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      const before = JSON.stringify(changed);
      mutate(changed);
      expect(JSON.stringify(changed), `${label} must change evidence`).not.toBe(before);
      const result = collaborationResumeReferenceTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
  });

  test("rejects coupled self-consistent identity, transcript, fact, and routing mutations", async () => {
    const baseline = await assembledExecution(DEFAULT_PROFILES[0]!);
    const originalId = childId(baseline);
    const cases: Mutation[] = [
      ["all dynamic ids", (value) => replaceEverySubstring(value, originalId, "sess-coupled-20000101-aaaaaa")],
      ["all nicknames", (value) => replaceEverySubstring(value, nickname(value), "coupled-plant")],
      ["first fact everywhere", (value) => replaceEverySubstring(value, value.world.tokens[0], "COUPLED_FIRST")],
      ["second fact everywhere", (value) => replaceEverySubstring(value, value.world.tokens[1], "COUPLED_SECOND")],
      ["both source paths", swapSourcePathsEverywhere],
      ["all child models", mutateAllChildModels],
      ["all child efforts", mutateAllChildEfforts],
      [
        "all final acknowledgements",
        (value) => replaceEverySubstring(value, value.world.acknowledgement, "COUPLED_ACK"),
      ],
      ["all final responses", (value) => replaceEverySubstring(value, value.world.finalResponse, "COUPLED_FINAL")],
      ["root and child linked headers", mutateLinkedHeaders],
    ];
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      const before = JSON.stringify(changed);
      mutate(changed);
      expect(JSON.stringify(changed), `${label} must change evidence`).not.toBe(before);
      const result = collaborationResumeReferenceTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
  });
});

async function assembledExecution(
  profile: EvalProfile,
  assembledOptions: AssembledExecutionOptions = {},
): Promise<RuntimeEvalExecution<CollaborationResumeReferenceWorld>> {
  const seed = "shared-seed-123";
  const result = await runRuntimeEvalExecution({
    task: collaborationResumeReferenceTask,
    seed,
    profile,
    streamFunction: fixtureStream(profile, seed, assembledOptions),
  });
  if (!Object.values(assembledOptions).some(Boolean)) {
    expect(
      result.failures,
      JSON.stringify({
        failures: result.failures,
        advertisedTools: result.execution.advertisedTools,
        sessionTypes: result.execution.session.lines.map((line) => (line as Record<string, unknown>).type),
        childSessionTypes: result.execution.childSessions.map((session) =>
          session.lines.map((line) => (line as Record<string, unknown>).type),
        ),
        threadReadEntryCounts: result.execution.threadReads.map((read) => read.response.entryCount),
        providerCalls: result.execution.providerCalls,
        toolCalls: result.execution.toolCalls,
        turns: result.execution.turns,
        session: result.execution.session,
        childSessions: result.execution.childSessions,
        threadReads: result.execution.threadReads,
        workspace: result.execution.workspace,
        runtimeState: result.execution.runtimeState,
      }),
    ).toEqual([]);
  }
  return result.execution as RuntimeEvalExecution<CollaborationResumeReferenceWorld>;
}

interface AssembledExecutionOptions {
  generatedIds?: boolean;
  semanticSpawnInputs?: boolean;
  omitSpawnOptionalDefaults?: boolean;
  omitResumeAgentType?: boolean;
  longWait?: boolean;
  includeProviderProgress?: boolean;
  explicitReadDefaults?: boolean;
  trailingChildReport?: boolean;
  inlineInitialChildReport?: boolean;
  verboseInitialChildReport?: boolean;
  trailingPatchNewline?: boolean;
  omitEditReplaceAll?: boolean;
  anthropicWriteRecovery?: boolean;
  deferredCombinedChildReport?: boolean;
}

function fixtureStream(
  profile: EvalProfile,
  seed: string,
  assembledOptions: AssembledExecutionOptions,
): StreamFunction {
  let parentCall = 0;
  let childCall = 0;
  const tokens = [seeded(seed, "FIRST_REFERENCE"), seeded(seed, "SECOND_REFERENCE")];
  const callIds = assembledOptions.generatedIds
    ? {
        spawnInitial: "runtime-spawn-initial",
        readInitial: "runtime-read-initial",
        waitInitial: "runtime-wait-initial",
        spawnFollowUp: "runtime-spawn-follow-up",
        readFollowUp: "runtime-read-follow-up",
        waitFollowUp: "runtime-wait-follow-up",
        write: "runtime-write-reference",
      }
    : COLLABORATION_RESUME_REFERENCE_TOOL_CALL_IDS;
  return (model, context, options) => {
    const response = context.systemPrompt.some((section) => section.label === "agent_role")
      ? childResponse(++childCall, context, tokens, callIds, assembledOptions)
      : parentResponse(++parentCall, profile, context, tokens, callIds, assembledOptions);
    return sequenceStream([response])(model, context, options);
  };
}

function childResponse(
  call: number,
  context: StreamContext,
  tokens: string[],
  callIds: Record<keyof typeof COLLABORATION_RESUME_REFERENCE_TOOL_CALL_IDS, string>,
  assembledOptions: AssembledExecutionOptions,
) {
  if (call === 1 || call === 3) {
    const index = call === 1 ? 0 : 1;
    return assistantMessage(
      [
        ...(assembledOptions.includeProviderProgress
          ? [{ type: "thinking" as const, thinking: "I will perform the one requested read." }]
          : []),
        {
          type: "tool_call",
          id: index === 0 ? callIds.readInitial : callIds.readFollowUp,
          name: "read",
          input: {
            file_path: join(
              cwdFromContext(context, "runtime_context"),
              index === 0 ? "references/initial.fact" : "references/follow-up.fact",
            ),
            ...(assembledOptions.explicitReadDefaults ? { offset: 1, limit: 2000 } : {}),
          },
        },
      ],
      "tool_use",
    );
  }
  const token = tokens[call === 2 ? 0 : 1]!;
  return assistantMessage([
    ...(assembledOptions.includeProviderProgress
      ? [{ type: "thinking" as const, thinking: "The requested value is ready." }]
      : []),
    {
      type: "text",
      text:
        assembledOptions.deferredCombinedChildReport && call === 2
          ? "Completed the single requested read."
          : assembledOptions.deferredCombinedChildReport && call === 4
            ? `${tokens[0]}  \n${tokens[1]}`
            : assembledOptions.verboseInitialChildReport && call === 2
              ? `Completed. Contents:\n\n\`\`\`text\n${token}\n\`\`\``
              : assembledOptions.inlineInitialChildReport && call === 2
                ? `\`${token}\``
                : assembledOptions.trailingChildReport
                  ? `${token}\n`
                  : token,
    },
  ]);
}

function parentResponse(
  call: number,
  profile: EvalProfile,
  context: StreamContext,
  tokens: string[],
  callIds: Record<keyof typeof COLLABORATION_RESUME_REFERENCE_TOOL_CALL_IDS, string>,
  assembledOptions: AssembledExecutionOptions,
) {
  if (call === 1 || call === 4) {
    const resume = call === 4;
    return assistantMessage(
      [
        ...(assembledOptions.includeProviderProgress
          ? [
              {
                type: "text" as const,
                text: resume ? "I will resume the prior specialist." : "I will delegate the lookup.",
              },
            ]
          : []),
        {
          type: "tool_call",
          id: resume ? callIds.spawnFollowUp : callIds.spawnInitial,
          name: "spawn_agent",
          input: {
            message: assembledOptions.semanticSpawnInputs
              ? resume
                ? "Continue the restored session. Read references/follow-up.fact once and return that file's exact contents alone; do not read references/initial.fact again."
                : "Retrieve the exact contents of references/initial.fact with one read and return the value alone."
              : resume
                ? "Continue the prior assignment by reading only references/follow-up.fact exactly once. Return only its exact token, without commentary or a trailing newline. Do not reread the initial reference."
                : "Read only references/initial.fact exactly once. Return only its exact token, without commentary or a trailing newline. Do not inspect any other reference.",
            ...(!resume || !assembledOptions.omitResumeAgentType ? { agent_type: "explore" } : {}),
            ...(resume ? { resume_id: spawnedThreadId(context) } : {}),
            ...(!assembledOptions.omitSpawnOptionalDefaults
              ? {
                  description: "Retrieve the private reference",
                  allow_nested_agents: false,
                }
              : {}),
          },
        },
      ],
      "tool_use",
    );
  }
  if (call === 2 || call === 5)
    return assistantMessage(
      [
        {
          type: "tool_call",
          id: call === 2 ? callIds.waitInitial : callIds.waitFollowUp,
          name: "wait",
          input: { ids: [spawnedThreadId(context)], timeout_ms: assembledOptions.longWait ? 900_000 : 30_000 },
        },
      ],
      "tool_use",
    );
  if (call === 3)
    return assistantMessage([
      ...(assembledOptions.includeProviderProgress
        ? [{ type: "thinking" as const, thinking: "I should acknowledge without revealing the value." }]
        : []),
      { type: "text", text: "REFERENCE_ACK" },
    ]);
  if (call === 6 && assembledOptions.anthropicWriteRecovery)
    return assistantMessage(
      [
        {
          type: "tool_call",
          id: `${callIds.write}-recovery`,
          name: "edit",
          input: {
            file_path: join(cwdFromContext(context, "base"), "collaboration-resume-reference.txt"),
            old_string: "DOES_NOT_EXIST_PLACEHOLDER",
            new_string: `${tokens[0]}\n${tokens[1]}\n`,
          },
        },
      ],
      "tool_use",
    );
  if (call === 6 || (call === 7 && assembledOptions.anthropicWriteRecovery))
    return assistantMessage(
      [
        {
          type: "tool_call",
          id: callIds.write,
          name: profile.provider === "anthropic" ? "edit" : "apply_patch",
          input:
            profile.provider === "anthropic"
              ? {
                  file_path: join(cwdFromContext(context, "base"), "collaboration-resume-reference.txt"),
                  old_string: "",
                  new_string: `${tokens[0]}\n${tokens[1]}\n`,
                  ...(!assembledOptions.omitEditReplaceAll ? { replace_all: false } : {}),
                }
              : {
                  patch: `*** Begin Patch\n*** Add File: collaboration-resume-reference.txt\n+${tokens[0]}\n+${tokens[1]}\n*** End Patch${assembledOptions.trailingPatchNewline ? "\n" : ""}`,
                },
        },
      ],
      "tool_use",
    );
  return assistantMessage([
    ...(assembledOptions.includeProviderProgress
      ? [{ type: "thinking" as const, thinking: "The ordered artifact is complete." }]
      : []),
    { type: "text", text: "REFERENCE_PAIR_RECORDED" },
  ]);
}

function cwdFromContext(context: StreamContext, label: "base" | "runtime_context") {
  const content = context.systemPrompt.find((section) => section.label === label)?.content ?? "";
  const match = content.match(/^Current working directory: (.+)$/m);
  if (!match?.[1]) throw new Error(`Missing ${label} cwd in provider context.`);
  return match[1];
}

function spawnedThreadId(context: StreamContext) {
  const ids = [...JSON.stringify(context.messages).matchAll(/\\"thread_id\\":\\"([^\\"]+)\\"/g)].map(
    (match) => match[1]!,
  );
  const unique = [...new Set(ids)];
  if (unique.length !== 1) throw new Error(`Expected one spawned child id, received ${unique.length}.`);
  return unique[0]!;
}

function childId(execution: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const trace = execution.toolCalls.find(
    (call) => call.name === "spawn_agent" && !("resume_id" in (call.input as Record<string, unknown>)),
  )!;
  return JSON.parse((trace.output as { output: string }).output).thread_id as string;
}

function nickname(execution: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const trace = execution.toolCalls.find(
    (call) => call.name === "spawn_agent" && !("resume_id" in (call.input as Record<string, unknown>)),
  )!;
  return JSON.parse((trace.output as { output: string }).output).nickname as string;
}

function seeded(seed: string, prefix: string) {
  return `${prefix}_${seed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "seed"}`;
}

type Mutation = [string, (value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) => void];

function failedEdit(value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  return value.toolCalls.find((call) => call.name === "edit" && call.outcome === "runtime_error")!;
}

function failedEditInput(value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  return failedEdit(value).input as Record<string, unknown>;
}

function appendExtraEdit(value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const extra = structuredClone(failedEdit(value));
  extra.sequence = value.toolCalls.length + 1;
  extra.toolCallId = `${extra.toolCallId}-extra`;
  value.toolCalls.push(extra);
}

function mutationCases(baseline: RuntimeEvalExecution<CollaborationResumeReferenceWorld>): Mutation[] {
  const cases: Mutation[] = [
    ["task id", (value) => (value.taskId = "wrong")],
    ["seed", (value) => (value.seed = "wrong")],
    ["world root", (value) => (value.world.root = "wrong")],
    ["world seed", (value) => (value.world.seed = "wrong")],
    ["first token", (value) => (value.world.tokens[0] = "wrong")],
    ["second token", (value) => (value.world.tokens[1] = "wrong")],
    ["first path", (value) => (value.world.sourcePaths[0] = "wrong")],
    ["second path", (value) => (value.world.sourcePaths[1] = "wrong")],
    ["first hash", (value) => (value.world.sourceHashes[0] = "wrong")],
    ["second hash", (value) => (value.world.sourceHashes[1] = "wrong")],
    ["artifact", (value) => (value.world.artifactPath = "wrong")],
    ["first prompt", (value) => (value.world.prompts[0] += " wrong")],
    ["second prompt", (value) => (value.world.prompts[1] += " wrong")],
    ["first brief", (value) => (value.world.workerBriefs[0] += " wrong")],
    ["second brief", (value) => (value.world.workerBriefs[1] += " wrong")],
    ["ack", (value) => (value.world.acknowledgement = "wrong")],
    ["final", (value) => (value.world.finalResponse = "wrong")],
    ["expected", (value) => (value.world.expected = "wrong")],
    ["expected hash", (value) => (value.world.expectedHash = "wrong")],
    ["protected", (value) => value.world.protectedPaths.pop()],
    ["allowed", (value) => value.world.allowedChanges.push("wrong")],
    ["runtime config", (value) => value.world.runtimeConfigs.pop()],
    ["runtime disabled", (value) => (value.world.runtimeConfigs[0]!.agentsEnabled = false)],
    ["runtime names", (value) => value.world.runtimeConfigs[0]!.builtinNames.reverse()],
    ["termination", (value) => (value.termination = "runtime_error")],
    ["error", (value) => (value.error = { name: "Error", message: "wrong" })],
    ["turn removed", (value) => value.turns.pop()],
    ["turn index", (value) => (value.turns[0]!.index = 7)],
    ["turn thread", (value) => (value.turns[0]!.threadId = "wrong")],
    ["turn prompt", (value) => (value.turns[1]!.clientPrompt += " wrong")],
    ["turn termination", (value) => (value.turns[1]!.termination = "failed")],
    ["cwd", (value) => (value.threadCwd = "wrong")],
    ["compaction", (value) => value.compactions.push({} as never)],
    ["protocol action", (value) => value.protocolActions.push({} as never)],
    ["advertised removed", (value) => value.advertisedTools.pop()],
    ["advertised sequence", (value) => (value.advertisedTools[0]!.sequence = 9)],
    ["advertised turn", (value) => (value.advertisedTools[1]!.turnIndex = 0)],
    ["advertised cwd", (value) => (value.advertisedTools[0]!.cwd = "wrong")],
    ["advertised mode", (value) => (value.advertisedTools[0]!.mode = "plan")],
    [
      "advertised provider",
      (value) =>
        (value.advertisedTools[0]!.provider =
          value.advertisedTools[0]!.provider === "anthropic" ? "openai" : "anthropic"),
    ],
    ["advertised duplicate", (value) => value.advertisedTools[0]!.tools.push("read")],
    ["provider removed", (value) => value.providerCalls.pop()],
    ["provider sequence", (value) => (value.providerCalls[0]!.sequence = 99)],
    ["provider model", (value) => (value.providerCalls[0]!.model.modelId = "wrong")],
    ["provider effort", (value) => (value.providerCalls[0]!.streamOptions.effort = "high")],
    ["provider session", (value) => (value.providerCalls[0]!.streamOptions.sessionId = "wrong")],
    ["provider max", (value) => (value.providerCalls[0]!.streamOptions.maxTokens = 1)],
    ["provider tool", (value) => ((value.providerCalls[0]!.tools.items[0] as { name: string }).name = "wrong")],
    ["tool removed", (value) => value.toolCalls.pop()],
    ["tool sequence", (value) => (value.toolCalls[0]!.sequence = 99)],
    ["tool id", (value) => (value.toolCalls[0]!.toolCallId = "wrong")],
    ["tool actor", (value) => (value.toolCalls[0]!.threadId = "wrong")],
    ["tool outcome", (value) => (value.toolCalls[0]!.outcome = "runtime_error")],
    ["tool error", (value) => (value.toolCalls[0]!.error = "wrong")],
    ["session id", (value) => (value.session.threadId = "wrong")],
    ["session line", (value) => value.session.lines.pop()],
    ["session header extra", (value) => ((value.session.lines[0] as Record<string, unknown>).extra = true)],
    ["session extra entry", appendRootEntry],
    ["child removed", (value) => value.childSessions.pop()],
    ["child id", (value) => (value.childSessions[0]!.threadId = "wrong")],
    ["child line", (value) => value.childSessions[0]!.lines.pop()],
    ["child header extra", (value) => ((value.childSessions[0]!.lines[0] as Record<string, unknown>).extra = true)],
    ["child extra entry", appendChildEntry],
    ["thread read removed", (value) => value.threadReads.pop()],
    ["thread phase", (value) => (value.threadReads[1]!.phase = "after_turn")],
    ["thread index", (value) => (value.threadReads[2]!.turnIndex = 0)],
    ["thread cwd", (value) => (value.threadReads[0]!.response.cwd = "wrong")],
    ["thread running", (value) => (value.threadReads[0]!.response.isRunning = true)],
    ["thread mode", (value) => (value.threadReads[0]!.response.currentMode = "plan")],
    ["thread effort", (value) => (value.threadReads[0]!.response.currentEffort = "low")],
    ["thread model", (value) => (value.threadReads[0]!.response.currentModel!.modelId = "wrong")],
    ["thread entry count", (value) => (value.threadReads[0]!.response.entryCount += 1)],
    [
      "thread error",
      (value) =>
        (value.threadReads[0]!.response.errors ??= []).push({
          id: "error-id",
          timestamp: "2026-07-18T00:00:00.000Z",
          fatal: false,
          error: { name: "Error", message: "wrong" },
        }),
    ],
    ["thread follow-up", (value) => (value.threadReads[0]!.response.hasFollowUp = true)],
    [
      "thread pending steer",
      (value) => (value.threadReads[0]!.response.pendingSteers ??= []).push({ id: "x", content: "y" }),
    ],
    ["thread message content", mutateThreadAgentMessage],
    ["approval", (value) => value.approvals.push({})],
    ["user input", (value) => value.userInputRequests.push({})],
    ["log", (value) => value.logs.push({ level: "info", message: "wrong" } as never)],
    ["tool output", (value) => value.toolOutputFiles.push({ path: "wrong", bytes: 1, sha256: "wrong" })],
    ["workspace initial", (value) => value.workspace.initial.entries.pop()],
    ["workspace final", (value) => value.workspace.final.entries.pop()],
    ["runtime diff", (value) => value.runtimeState.diff.push({ path: "wrong", category: "other", change: "added" })],
    ["verifier exit", (value) => (value.verifier!.exitCode = 1)],
    ["verifier timeout", (value) => (value.verifier!.timedOut = true)],
    ["verifier stdout", (value) => (value.verifier!.stdout = "wrong")],
    ["verifier stderr", (value) => (value.verifier!.stderr = "wrong")],
    ["verifier argv", (value) => value.verifier!.argv.push("wrong")],
    ["provider tool-call extra block", mutateProviderToolCallContent],
    ["persisted tool-call extra block", mutatePersistedToolCallContent],
    ["persisted child final extra block", mutatePersistedChildFinal],
    ["turn final extra block", mutateTurnFinal],
    ["spawn running status", (value) => mutateMirroredEvent(value, 0, "collab_spawn_end", "status", "pending")],
    ["spawn prompt", (value) => mutateMirroredEvent(value, 0, "collab_spawn_begin", "prompt", "wrong")],
    ["wait end call id", (value) => mutateMirroredEvent(value, 0, "collab_wait_end", "callId", "wrong")],
  ];
  for (const [turnIndex, turn] of baseline.turns.entries()) {
    for (const [eventIndex] of turn.coreEvents.entries()) {
      cases.push([
        `turn ${turnIndex} core event ${eventIndex}`,
        (value) =>
          (((value.turns[turnIndex]!.coreEvents[eventIndex]!.event as Record<string, unknown>).type as string) +=
            "_wrong"),
      ]);
      cases.push([
        `turn ${turnIndex} runtime event ${eventIndex}`,
        (value) =>
          (((value.turns[turnIndex]!.runtimeEvents[eventIndex] as Record<string, unknown>).type as string) += "_wrong"),
      ]);
      cases.push([
        `turn ${turnIndex} notification event ${eventIndex}`,
        (value) => {
          const notice = value.turns[turnIndex]!.notifications.filter((item) => item.method === "agent/event")[
            eventIndex
          ]!;
          const event = (notice.params as unknown as { event: Record<string, unknown> }).event;
          event.type = `${event.type}_wrong`;
        },
      ]);
    }
  }
  return cases;
}

function appendRootEntry(value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const last = value.session.lines.at(-1) as Record<string, unknown>;
  value.session.lines.push({
    type: "error",
    id: "extra-root-entry",
    parentId: last.id,
    timestamp: "2026-07-18T00:00:00.000Z",
    error: { name: "Error", message: "injected" },
  });
}

function appendChildEntry(value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const lines = value.childSessions[0]!.lines;
  const last = lines.at(-1) as Record<string, unknown>;
  lines.push({
    type: "error",
    id: "extra-child-entry",
    parentId: last.id,
    timestamp: "2026-07-18T00:00:00.000Z",
    error: { name: "Error", message: "injected" },
  });
}

function mutateThreadAgentMessage(value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const item = value.threadReads[0]!.response.items.find(
    (candidate) => (candidate as unknown as Record<string, unknown>).type === "agentMessage",
  ) as unknown as { message: { content: unknown[] } };
  item.message.content.push({ type: "tool_call", id: "wrong", name: "read", input: { file_path: "wrong" } });
}

function mutateProviderToolCallContent(value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const message = value.providerCalls[1]!.messages.items[1] as { content: unknown[] };
  message.content.push({ type: "tool_call", id: "wrong", name: "read", input: { file_path: "wrong" } });
}

function mutatePersistedToolCallContent(value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const line = value.session.lines[3] as { message: { content: unknown[] } };
  line.message.content.push({ type: "tool_call", id: "wrong", name: "read", input: { file_path: "wrong" } });
}

function mutatePersistedChildFinal(value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const line = value.childSessions[0]!.lines.at(-1) as { message: { content: unknown[] } };
  line.message.content.push({ type: "text", text: "wrong" });
}

function mutateTurnFinal(value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const message = value.turns[1]!.messages.at(-1) as { content: unknown[] };
  message.content.push({ type: "text", text: "wrong" });
}

function mutateMirroredEvent(
  value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>,
  turnIndex: number,
  type: string,
  field: string,
  replacement: unknown,
) {
  const turn = value.turns[turnIndex]!;
  const core = turn.coreEvents.find((entry) => (entry.event as Record<string, unknown>).type === type)!.event;
  const runtime = turn.runtimeEvents.find((event) => (event as Record<string, unknown>).type === type)!;
  const notice = turn.notifications.find(
    (candidate) =>
      candidate.method === "agent/event" &&
      ((candidate.params as unknown as { event: Record<string, unknown> }).event.type as string) === type,
  )!;
  (core as Record<string, unknown>)[field] = replacement;
  (runtime as Record<string, unknown>)[field] = replacement;
  (notice.params as unknown as { event: Record<string, unknown> }).event[field] = replacement;
}

function replaceEverySubstring(value: unknown, from: string, to: string) {
  const visit = (current: unknown): unknown => {
    if (typeof current === "string") return current.split(from).join(to);
    if (Array.isArray(current)) return current.map(visit);
    if (current && typeof current === "object") {
      for (const [key, item] of Object.entries(current)) (current as Record<string, unknown>)[key] = visit(item);
    }
    return current;
  };
  visit(value);
}

function swapSourcePathsEverywhere(value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const marker = "references/__swap__.fact";
  replaceEverySubstring(value, value.world.sourcePaths[0], marker);
  replaceEverySubstring(value, value.world.sourcePaths[1], value.world.sourcePaths[0]);
  replaceEverySubstring(value, marker, value.world.sourcePaths[1]);
}

function mutateAllChildModels(value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const id = childId(value);
  for (const call of value.providerCalls.filter((candidate) => candidate.sessionId === id))
    call.model.modelId = "coupled-model";
}

function mutateAllChildEfforts(value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const id = childId(value);
  for (const call of value.providerCalls.filter((candidate) => candidate.sessionId === id))
    call.streamOptions.effort = "high";
}

function mutateLinkedHeaders(value: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  (value.session.lines[0] as Record<string, unknown>).id = "coupled-parent";
  (value.childSessions[0]!.lines[0] as Record<string, unknown>).parentSession = "coupled-parent";
}
