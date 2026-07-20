// @summary Contract, real-runtime execution, and strict mutation coverage for custom-agent-routing

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
  CUSTOM_AGENT_ROUTING_TOOL_CALL_IDS,
  type CustomAgentRoutingWorld,
  customAgentRoutingTask,
} from "../../../src/tasks/runtime/custom-agent-routing";
import { assistantMessage, sequenceStream } from "../../helpers/fake-stream";

describe("custom-agent-routing", () => {
  test("runs one genuine discovered custom agent through the real collaboration runtime for both providers", async () => {
    expect(customAgentRoutingTask.fixtureVersion).toBe("custom-agent-routing-v9");
    expect(DEFAULT_PROFILES).toHaveLength(2);
    for (const profile of DEFAULT_PROFILES) {
      const execution = await assembledExecution(profile);
      expect(customAgentRoutingTask.evaluate(execution), profile.provider).toEqual({ passed: true });
      expect(execution.world.releaseAgent.body).toContain(execution.world.releasePath);
      expect(execution.world.releaseAgent.body).toContain("Current working directory");
      expect(execution.world.releaseAgent.body).toContain("append the fixed suffix");
      expect(execution.world.clientPrompt).not.toContain(execution.world.releasePath);
      expect(execution.world.clientPrompt).toContain(execution.world.artifactPath);
      expect(execution.world.clientPrompt).toContain(execution.world.finalResponse);
      expect(execution.world.clientPrompt).toContain("create a new file named");
      expect(execution.world.clientPrompt).toContain("including its trailing newline");
      expect(execution.toolCalls.map((call) => call.name)).toEqual([
        "spawn_agent",
        "read",
        "wait",
        profile.provider === "anthropic" ? "edit" : "apply_patch",
      ]);
      const parentModel = resolveModel({ provider: profile.provider, modelId: profile.model });
      const childModel = resolveModelForClass(parentModel, "lite");
      const childId = execution.childSessions[0]!.threadId;
      const childCalls = execution.providerCalls.filter((call) => call.sessionId === childId);
      expect(childCalls.map((call) => call.model.modelId)).toEqual([childModel.modelId, childModel.modelId]);
      expect(
        childCalls.every(
          (call) => call.tools.items.map((tool) => (tool as { name?: string }).name).join(",") === "read",
        ),
      ).toBe(true);
    }
  });

  test("accepts provider-native collaboration phrasing, generated ids, progress blocks, wait timeout, and interleaving", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!, {
      generatedIds: true,
      includeProgressText: true,
      liveSpawnWording: true,
      waitBeforeChildTrace: true,
      maximumWaitTimeout: true,
      trailingPatchNewline: true,
    });
    expect(execution.toolCalls.map((call) => call.name)).toEqual(["spawn_agent", "wait", "read", "apply_patch"]);
    expect(execution.toolCalls[0]!.input).toMatchObject({
      description: "Retrieve release authorization capsule",
      agent_type: "release-authorization-liaison",
    });
    expect(execution.toolCalls[1]!.input).toMatchObject({ timeout_ms: 3_600_000 });
    expect(new Set(execution.toolCalls.map((call) => call.toolCallId)).size).toBe(4);
    expect((execution.toolCalls[3]!.input as { patch: string }).patch.endsWith("*** End Patch\n")).toBe(true);
    expect(customAgentRoutingTask.evaluate(execution)).toMatchObject({ passed: true });

    (execution.toolCalls[0]!.input as { description: string }).description = "Retrieve current authorization capsule";
    expect(customAgentRoutingTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("accepts omitted optional collaboration inputs and a bounded linked child report", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "anthropic")!;
    const execution = await assembledExecution(profile, {
      omitSpawnDescription: true,
      omitWaitTimeout: true,
      wrappedChildReport: true,
    });
    expect(execution.toolCalls[0]!.input).not.toHaveProperty("description");
    expect(execution.toolCalls[1]!.input).not.toHaveProperty("timeout_ms");
    const childFinal = (
      execution.childSessions[0]!.lines.at(-1) as {
        message: { content: Array<{ text?: string }> };
      }
    ).message.content.find((block) => block.text)?.text;
    expect(childFinal).toContain(execution.world.releaseToken);
    expect(childFinal).not.toBe(execution.world.releaseToken);
    expect(customAgentRoutingTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("accepts one bounded Anthropic relative-path edit recovery before the exact write", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "anthropic")!;
    const execution = await assembledExecution(profile, { relativeWriteRecovery: true });
    expect(execution.toolCalls.slice(-2).map((call) => [call.name, call.outcome])).toEqual([
      ["edit", "runtime_error"],
      ["edit", "success"],
    ]);
    expect(customAgentRoutingTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("accepts one bounded OpenAI patch-envelope recovery before the exact write", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "openai")!;
    const execution = await assembledExecution(profile, { invalidPatchRecovery: true });
    expect(execution.toolCalls.slice(-2).map((call) => [call.name, call.outcome])).toEqual([
      ["apply_patch", "runtime_error"],
      ["apply_patch", "success"],
    ]);
    expect(customAgentRoutingTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("accepts omission of the provider edit flag when the runtime records its false schema default", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "anthropic")!;
    const execution = await assembledExecution(profile);
    for (const surface of [execution.providerCalls, execution.turns, execution.session, execution.threadReads]) {
      removePersistedEditDefault(surface);
    }
    expect(execution.toolCalls[3]!.input).toMatchObject({ replace_all: false });
    expect(customAgentRoutingTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("does not gate routing on persistence mirrors, infrastructure bytes, or verifier wording", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!);
    execution.session.lines = [];
    execution.childSessions[0]!.lines = [];
    execution.threadReads = [];
    execution.turns[0]!.coreEvents = [];
    execution.turns[0]!.runtimeEvents = [];
    execution.turns[0]!.notifications = [];
    const gitignore = execution.workspace.final.entries.find((entry) => entry.path === ".diligent/.gitignore")!;
    gitignore.size += 1;
    gitignore.sha256 = "f".repeat(64);
    execution.verifier!.argv = ["deterministic-verifier"];
    execution.verifier!.stdout = "alternate success wording\n";
    expect(customAgentRoutingTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("accepts a provider thinking block beside the exact persisted child result", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!);
    const childFinal = (execution.childSessions[0]!.lines.at(-1) as { message: { content: unknown[] } }).message;
    childFinal.content.unshift({
      type: "thinking",
      thinking: "",
      providerState: { provider: "openai", itemId: "provider-item", encryptedContent: "opaque" },
    });
    expect(customAgentRoutingTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("rejects at least 120 independently guarded mutations across strict evidence surfaces", async () => {
    const baseline = await assembledExecution(DEFAULT_PROFILES[0]!);
    expect(customAgentRoutingTask.evaluate(baseline)).toEqual({ passed: true });
    const cases = mutationCases(baseline);
    expect(cases.length).toBeGreaterThanOrEqual(120);
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      const before = JSON.stringify(changed);
      mutate(changed);
      expect(JSON.stringify(changed), `${label} must change evidence`).not.toBe(before);
      const result = customAgentRoutingTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
  });

  test("rejects focused Anthropic native edit mutations with a no-op guard", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "anthropic")!;
    const baseline = await assembledExecution(profile);
    const cases: Array<[string, (value: RuntimeEvalExecution<CustomAgentRoutingWorld>) => void]> = [
      ["edit path", (value) => ((value.toolCalls[3]!.input as Record<string, unknown>).file_path = "wrong")],
      ["edit old string", (value) => ((value.toolCalls[3]!.input as Record<string, unknown>).old_string = "wrong")],
      ["edit new string", (value) => ((value.toolCalls[3]!.input as Record<string, unknown>).new_string = "wrong")],
      ["edit replace all", (value) => ((value.toolCalls[3]!.input as Record<string, unknown>).replace_all = true)],
      ["edit output", (value) => ((value.toolCalls[3]!.output as Record<string, unknown>).output = "wrong")],
      ["edit images", (value) => ((value.toolCalls[3]!.output as Record<string, unknown>).outputImages = [])],
      [
        "edit render input",
        (value) =>
          (((value.toolCalls[3]!.output as Record<string, unknown>).render as Record<string, unknown>).inputSummary =
            "wrong"),
      ],
      [
        "edit render output",
        (value) =>
          (((value.toolCalls[3]!.output as Record<string, unknown>).render as Record<string, unknown>).outputSummary =
            "wrong"),
      ],
    ];
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      const before = JSON.stringify(changed);
      mutate(changed);
      expect(JSON.stringify(changed), `${label} must change evidence`).not.toBe(before);
      const result = customAgentRoutingTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
  });

  test("rejects coupled model, persistence, lifecycle, and diagnostic mutations", async () => {
    const baseline = await assembledExecution(DEFAULT_PROFILES[0]!);
    const childId = baseline.childSessions[0]!.threadId;
    const cases: Mutation[] = [
      [
        "coupled child model",
        (value) => {
          for (const call of value.providerCalls.filter((candidate) => candidate.sessionId === childId)) {
            call.model.modelId = "wrong-child-model";
          }
        },
      ],
      [
        "coupled child effort",
        (value) => {
          for (const call of value.providerCalls.filter((candidate) => candidate.sessionId === childId)) {
            call.streamOptions.effort = "high";
          }
        },
      ],
      [
        "child session cwd",
        (value) => {
          (value.childSessions[0]!.lines[0] as Record<string, unknown>).cwd = "wrong";
        },
      ],
      [
        "root persisted final",
        (value) => {
          if (!replaceFirstExactText(value.session.lines, "RELEASE_AUTHORIZATION_RECORDED", "wrong")) {
            throw new Error("Missing persisted root final response.");
          }
        },
      ],
      [
        "thread-read final",
        (value) => {
          if (!replaceFirstExactText(value.threadReads[0]!.response, "RELEASE_AUTHORIZATION_RECORDED", "wrong")) {
            throw new Error("Missing thread-read final response.");
          }
        },
      ],
      [
        "coupled extra lifecycle event",
        (value) => {
          const event = { type: "unexpected_eval_event", marker: "wrong" };
          value.turns[0]!.coreEvents.push({
            sequence: value.turns[0]!.coreEvents.length + 1,
            relativeMs: value.turns[0]!.coreEvents.at(-1)!.relativeMs,
            event: structuredClone(event),
          } as never);
          value.turns[0]!.runtimeEvents.push(structuredClone(event) as never);
          value.turns[0]!.notifications.push({
            method: "agent/event",
            params: {
              threadId: value.turns[0]!.threadId,
              turnId: "unexpected-turn",
              event: structuredClone(event),
            },
          } as never);
        },
      ],
      ["coupled child lifecycle id", mutateCoupledChildLifecycleId],
      [
        "thread-read completed wait output",
        (value) => {
          const item = value.threadReads[0]!.response.items.find((candidate) => {
            const record = candidate as unknown as Record<string, unknown>;
            return record.type === "toolCall" && record.toolName === "wait" && typeof record.output === "string";
          }) as unknown as Record<string, unknown>;
          item.output = "wrong";
        },
      ],
      [
        "root persisted write render",
        (value) => {
          const line = value.session.lines.find((candidate) => {
            const message = (candidate as unknown as Record<string, unknown>).message as
              | Record<string, unknown>
              | undefined;
            return (
              message?.role === "tool_result" && (message.toolName === "apply_patch" || message.toolName === "edit")
            );
          }) as unknown as Record<string, unknown>;
          const message = line.message as Record<string, unknown>;
          (message.render as Record<string, unknown>).outputSummary = "wrong";
        },
      ],
      [
        "provider child read render",
        (value) => {
          const call = value.providerCalls.find(
            (candidate) => candidate.sessionId === childId && candidate.messages.totalCount === 3,
          )!;
          const result = call.messages.items.find(
            (candidate) => (candidate as Record<string, unknown>).role === "tool_result",
          ) as Record<string, unknown>;
          (result.render as Record<string, unknown>).outputSummary = "wrong";
        },
      ],
      ["diagnostic log", (value) => value.logs.push({ level: "info", message: "unexpected" } as never)],
    ];
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      const before = JSON.stringify(changed);
      mutate(changed);
      expect(JSON.stringify(changed), `${label} must change evidence`).not.toBe(before);
      const result = customAgentRoutingTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
  });
});

interface AssembledExecutionOptions {
  generatedIds?: boolean;
  includeProgressText?: boolean;
  liveSpawnWording?: boolean;
  waitBeforeChildTrace?: boolean;
  maximumWaitTimeout?: boolean;
  trailingPatchNewline?: boolean;
  omitSpawnDescription?: boolean;
  omitWaitTimeout?: boolean;
  wrappedChildReport?: boolean;
  relativeWriteRecovery?: boolean;
  invalidPatchRecovery?: boolean;
}

async function assembledExecution(
  profile: EvalProfile,
  assembledOptions: AssembledExecutionOptions = {},
): Promise<RuntimeEvalExecution<CustomAgentRoutingWorld>> {
  const seed = "shared-seed-123";
  const result = await runRuntimeEvalExecution({
    task: customAgentRoutingTask,
    seed,
    profile,
    streamFunction: fixtureStream(profile, seed, assembledOptions),
  });
  if (!Object.values(assembledOptions).some(Boolean)) {
    expect(
      result.failures,
      JSON.stringify({
        failures: result.failures,
        toolCalls: result.execution.toolCalls,
        childSessions: result.execution.childSessions,
        workspace: result.execution.workspace,
      }),
    ).toEqual([]);
  }
  return result.execution as RuntimeEvalExecution<CustomAgentRoutingWorld>;
}

function fixtureStream(
  profile: EvalProfile,
  seed: string,
  assembledOptions: AssembledExecutionOptions,
): StreamFunction {
  let parentCall = 0;
  let childCall = 0;
  const token = seeded(seed, "RELEASE_CAPSULE");
  const callIds = assembledOptions.generatedIds
    ? { spawn: "runtime-spawn", read: "runtime-read", wait: "runtime-wait", write: "runtime-write" }
    : CUSTOM_AGENT_ROUTING_TOOL_CALL_IDS;
  const childReport = assembledOptions.wrappedChildReport
    ? `Here is the exact capsule content:\n\n\`\`\`\n${token}\n\`\`\`\n\nComplete capsule identifier: ${token}.`
    : token;
  return (model, context, options) => {
    const child = context.systemPrompt.some((section) => section.label === "agent_role");
    const response = child
      ? ++childCall === 1
        ? assistantMessage(
            [
              {
                type: "tool_call",
                id: callIds.read,
                name: "read",
                input: { file_path: join(cwdFromContext(context, "runtime_context"), "vault/current-release.capsule") },
              },
            ],
            "tool_use",
          )
        : assistantMessage([{ type: "text", text: childReport }])
      : parentResponse(++parentCall, profile, context, token, callIds, assembledOptions);
    return child || parentCall !== 2 || assembledOptions.waitBeforeChildTrace
      ? sequenceStream([response])(model, context, options)
      : delayedMessage(response, model, options.signal);
  };
}

function delayedMessage(message: AssistantMessage, model: Parameters<StreamFunction>[0], signal?: AbortSignal) {
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
  }, 10);
  return stream;
}

function parentResponse(
  call: number,
  profile: EvalProfile,
  context: StreamContext,
  token: string,
  callIds: Record<keyof typeof CUSTOM_AGENT_ROUTING_TOOL_CALL_IDS, string>,
  assembledOptions: AssembledExecutionOptions,
) {
  if (call === 1)
    return assistantMessage(
      [
        ...(assembledOptions.includeProgressText
          ? [{ type: "text" as const, text: "I will delegate this to the release specialist." }]
          : []),
        {
          type: "tool_call",
          id: callIds.spawn,
          name: "spawn_agent",
          input: {
            message: assembledOptions.liveSpawnWording
              ? "Retrieve the current release authorization capsule for this workspace. Inspect only the available release-authorization context and report the capsule without modifying files."
              : "Read only vault/current-release.capsule exactly once. Return only the capsule token, without commentary or a trailing newline.",
            ...(!assembledOptions.omitSpawnDescription
              ? {
                  description: assembledOptions.liveSpawnWording
                    ? "Retrieve release authorization capsule"
                    : "Retrieve current release authorization",
                }
              : {}),
            agent_type: "release-authorization-liaison",
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
            ids: [spawnedThreadId(context)],
            ...(!assembledOptions.omitWaitTimeout
              ? {
                  timeout_ms: assembledOptions.maximumWaitTimeout
                    ? 3_600_000
                    : assembledOptions.liveSpawnWording
                      ? 900_000
                      : 30_000,
                }
              : {}),
          },
        },
      ],
      "tool_use",
    );
  if (call === 3 && assembledOptions.relativeWriteRecovery)
    return assistantMessage(
      [
        {
          type: "tool_call",
          id: "route-write-recovery-call",
          name: "edit",
          input: {
            file_path: "release-authorization.txt",
            old_string: "",
            new_string: `${token}\n`,
            replace_all: false,
          },
        },
      ],
      "tool_use",
    );
  if (call === 3 && assembledOptions.invalidPatchRecovery)
    return assistantMessage(
      [
        {
          type: "tool_call",
          id: "route-patch-recovery-call",
          name: "apply_patch",
          input: {
            patch: `*** Begin Patch\n*** Add File: release-authorization.txt\n+${token}\n*** End of File\n*** End Patch`,
          },
        },
      ],
      "tool_use",
    );
  if (call === (assembledOptions.relativeWriteRecovery || assembledOptions.invalidPatchRecovery ? 4 : 3))
    return assistantMessage(
      [
        ...(assembledOptions.includeProgressText
          ? [{ type: "text" as const, text: "I will record the specialist result." }]
          : []),
        {
          type: "tool_call",
          id: callIds.write,
          name: profile.provider === "anthropic" ? "edit" : "apply_patch",
          input:
            profile.provider === "anthropic"
              ? {
                  file_path: join(cwdFromContext(context, "base"), "release-authorization.txt"),
                  old_string: "",
                  new_string: `${token}\n`,
                  replace_all: false,
                }
              : {
                  patch: `*** Begin Patch\n*** Add File: release-authorization.txt\n+${token}\n*** End Patch${assembledOptions.trailingPatchNewline ? "\n" : ""}`,
                },
        },
      ],
      "tool_use",
    );
  return assistantMessage([{ type: "text", text: "RELEASE_AUTHORIZATION_RECORDED" }]);
}

function cwdFromContext(context: StreamContext, label: "base" | "runtime_context"): string {
  const content = context.systemPrompt.find((section) => section.label === label)?.content ?? "";
  const match = content.match(/^Current working directory: (.+)$/m);
  if (!match?.[1]) throw new Error(`Missing ${label} cwd in provider context.`);
  return match[1];
}

function spawnedThreadId(context: StreamContext): string {
  const match = JSON.stringify(context.messages).match(/\\"thread_id\\":\\"([^\\"]+)\\"/);
  if (!match?.[1]) throw new Error("Missing spawned child thread id in parent context.");
  return match[1];
}

function seeded(seed: string, prefix: string): string {
  return `${prefix}_${seed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "seed"}`;
}

function removePersistedEditDefault(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) removePersistedEditDefault(child);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const isEditCall =
    (record.type === "tool_call" && record.name === "edit") ||
    ((record.type === "toolCall" || record.type === "tool_start") && record.toolName === "edit");
  if (isEditCall && typeof record.input === "object" && record.input) {
    delete (record.input as Record<string, unknown>).replace_all;
  }
  for (const child of Object.values(record)) removePersistedEditDefault(child);
}

type Mutation = [string, (value: RuntimeEvalExecution<CustomAgentRoutingWorld>) => void];

function mutationCases(baseline: RuntimeEvalExecution<CustomAgentRoutingWorld>): Mutation[] {
  const cases: Mutation[] = [
    ["task id", (value) => (value.taskId = "wrong")],
    ["seed", (value) => (value.seed = "wrong")],
    ["world seed", (value) => (value.world.seed = "wrong")],
    ["world root", (value) => (value.world.root = "wrong")],
    ["world expected", (value) => (value.world.expected = "wrong")],
    ["release token", (value) => (value.world.releaseToken = "wrong")],
    ["decoy token", (value) => (value.world.decoyToken = "wrong")],
    ["release path", (value) => (value.world.releasePath = "wrong")],
    ["decoy path", (value) => (value.world.decoyPath = "wrong")],
    ["artifact path", (value) => (value.world.artifactPath = "wrong")],
    ["client prompt", (value) => (value.world.clientPrompt += " changed")],
    ["worker brief", (value) => (value.world.workerBrief += " changed")],
    ["final response", (value) => (value.world.finalResponse = "wrong")],
    ["expected hash", (value) => (value.world.expectedHash = "wrong")],
    ["release source hash", (value) => (value.world.releaseSourceHash = "wrong")],
    ["decoy source hash", (value) => (value.world.decoySourceHash = "wrong")],
    ["protected path", (value) => value.world.protectedPaths.pop()],
    ["allowed path", (value) => value.world.allowedChanges.push("wrong")],
    ["release name", (value) => (value.world.releaseAgent.name = "wrong")],
    ["release description", (value) => (value.world.releaseAgent.description = "wrong")],
    ["release body", (value) => (value.world.releaseAgent.body = "wrong")],
    ["release tools", (value) => value.world.releaseAgent.tools!.push("edit")],
    ["release class", (value) => (value.world.releaseAgent.defaultModelClass = "pro")],
    ["release agent path", (value) => (value.world.releaseAgent.path = "wrong")],
    ["release agent content", (value) => (value.world.releaseAgent.content += " ")],
    ["release agent hash", (value) => (value.world.releaseAgent.hash = "wrong")],
    ["decoy name", (value) => (value.world.decoyAgent.name = "wrong")],
    ["decoy description", (value) => (value.world.decoyAgent.description = "wrong")],
    ["decoy body", (value) => (value.world.decoyAgent.body = "wrong")],
    ["decoy tools", (value) => (value.world.decoyAgent.tools = ["read"])],
    ["decoy class", (value) => (value.world.decoyAgent.defaultModelClass = "lite")],
    ["decoy agent path", (value) => (value.world.decoyAgent.path = "wrong")],
    ["decoy agent content", (value) => (value.world.decoyAgent.content += " ")],
    ["decoy agent hash", (value) => (value.world.decoyAgent.hash = "wrong")],
    ["runtime config missing", (value) => value.world.runtimeConfigs.pop()],
    ["runtime discovered", (value) => value.world.runtimeConfigs[0]!.discoveredNames.pop()],
    ["runtime available", (value) => value.world.runtimeConfigs[0]!.availableNames.reverse()],
    ["runtime catalog", (value) => value.world.runtimeConfigs[0]!.catalogCustomNames.push("wrong")],
    ["runtime definitions", (value) => value.world.runtimeConfigs[0]!.definitionCustomNames.pop()],
    ["runtime agents disabled", (value) => (value.world.runtimeConfigs[0]!.agentsEnabled = false)],
    ["runtime prompt", (value) => (value.world.runtimeConfigs[0]!.systemAgentsSection += " wrong")],
    ["termination", (value) => (value.termination = "runtime_error")],
    ["error", (value) => (value.error = { name: "Error", message: "wrong" })],
    ["extra turn", (value) => value.turns.push(structuredClone(value.turns[0]!))],
    ["turn index", (value) => (value.turns[0]!.index = 1)],
    ["turn termination", (value) => (value.turns[0]!.termination = "failed")],
    ["turn thread", (value) => (value.turns[0]!.threadId = "wrong")],
    ["turn prompt", (value) => (value.turns[0]!.clientPrompt += " wrong")],
    ["prompt name leak", (value) => (value.turns[0]!.clientPrompt += " release-authorization-liaison")],
    ["prompt token leak", (value) => (value.turns[0]!.clientPrompt += ` ${value.world.releaseToken}`)],
    ["prompt path leak", (value) => (value.turns[0]!.clientPrompt += " vault/current-release.capsule")],
    ["thread cwd", (value) => (value.threadCwd = "wrong")],
    ["thread read missing", (value) => value.threadReads.pop()],
    ["thread phase", (value) => (value.threadReads[0]!.phase = "after_resume")],
    ["thread index", (value) => (value.threadReads[0]!.turnIndex = 1)],
    ["thread cwd response", (value) => (value.threadReads[0]!.response.cwd = "wrong")],
    ["thread running", (value) => (value.threadReads[0]!.response.isRunning = true)],
    ["thread mode", (value) => (value.threadReads[0]!.response.currentMode = "plan")],
    ["thread effort", (value) => (value.threadReads[0]!.response.currentEffort = "low")],
    ["thread model", (value) => (value.threadReads[0]!.response.currentModel!.modelId = "wrong")],
    ["root session", (value) => (value.session.threadId = "wrong")],
    ["child missing", (value) => value.childSessions.pop()],
    ["child extra", (value) => value.childSessions.push(structuredClone(value.childSessions[0]!))],
    ["child thread", (value) => (value.childSessions[0]!.threadId = "wrong")],
    ["child lines", (value) => value.childSessions[0]!.lines.pop()],
    ["root lines", (value) => value.session.lines.pop()],
    ["compaction", (value) => value.compactions.push({} as never)],
    ["protocol action", (value) => value.protocolActions.push({} as never)],
    ["approval", (value) => value.approvals.push({})],
    ["input request", (value) => value.userInputRequests.push({})],
    ["tool output file", (value) => value.toolOutputFiles.push({ path: "wrong", bytes: 1, sha256: "wrong" })],
    ["runtime state", (value) => value.runtimeState.diff.push({ path: "wrong", category: "other", change: "added" })],
    ["verifier missing", (value) => (value.verifier = undefined)],
    ["verifier exit", (value) => (value.verifier!.exitCode = 1)],
    ["verifier timeout", (value) => (value.verifier!.timedOut = true)],
    ["verifier argv", (value) => value.verifier!.argv.push("wrong")],
    ["verifier stdout", (value) => (value.verifier!.stdout = "wrong")],
    ["verifier stderr", (value) => (value.verifier!.stderr = "wrong")],
    ["workspace initial", (value) => value.workspace.initial.entries.pop()],
    ["workspace final", (value) => value.workspace.final.entries.pop()],
    ["workspace extra", (value) => value.workspace.final.entries.push({ path: "wrong", kind: "file", size: 1 })],
    ["final response", (value) => setFinal(value, "wrong")],
    ["final fact leak", (value) => setFinal(value, value.world.releaseToken)],
    ["final decoy leak", (value) => setFinal(value, value.world.decoyToken)],
    ["core lifecycle omission", (value) => value.turns[0]!.coreEvents.pop()],
    ["runtime lifecycle omission", (value) => value.turns[0]!.runtimeEvents.pop()],
    [
      "notification lifecycle omission",
      (value) => {
        const index = value.turns[0]!.notifications.findIndex((notice) => notice.method === "agent/event");
        value.turns[0]!.notifications.splice(index, 1);
      },
    ],
    ["core lifecycle sequence", (value) => (value.turns[0]!.coreEvents[0]!.sequence = 99)],
    ["coupled collab actor", mutateCoupledCollabActor],
    ["coupled lifecycle final", (value) => replaceEveryExactText(value, "RELEASE_AUTHORIZATION_RECORDED", "wrong")],
  ];
  for (let index = 0; index < baseline.providerCalls.length; index += 1) {
    cases.push(
      [`provider ${index} sequence`, (value) => (value.providerCalls[index]!.sequence = 99)],
      [`provider ${index} session`, (value) => (value.providerCalls[index]!.sessionId = "wrong")],
      [`provider ${index} model`, (value) => (value.providerCalls[index]!.model.modelId = "wrong")],
      [`provider ${index} effort`, (value) => (value.providerCalls[index]!.streamOptions.effort = "wrong")],
      [`provider ${index} stream session`, (value) => (value.providerCalls[index]!.streamOptions.sessionId = "wrong")],
      [`provider ${index} bounds`, (value) => (value.providerCalls[index]!.bounds.maxDepth += 1)],
      [`provider ${index} message count`, (value) => (value.providerCalls[index]!.messages.totalCount += 1)],
      [
        `provider ${index} tool name`,
        (value) => ((value.providerCalls[index]!.tools.items[0] as { name: string }).name = "wrong"),
      ],
    );
  }
  for (let index = 0; index < baseline.toolCalls.length; index += 1) {
    cases.push(
      [`trace ${index} sequence`, (value) => (value.toolCalls[index]!.sequence = 99)],
      [`trace ${index} id`, (value) => (value.toolCalls[index]!.toolCallId = "wrong")],
      [`trace ${index} name`, (value) => (value.toolCalls[index]!.name = "wrong")],
      [`trace ${index} actor`, (value) => (value.toolCalls[index]!.threadId = "wrong")],
      [`trace ${index} capability`, (value) => (value.toolCalls[index]!.capability = "execute")],
      [`trace ${index} outcome`, (value) => (value.toolCalls[index]!.outcome = "runtime_error")],
      [`trace ${index} input`, (value) => (value.toolCalls[index]!.input = { wrong: true })],
      [`trace ${index} output`, (value) => (value.toolCalls[index]!.output = { output: "wrong" })],
    );
  }
  return cases;
}

function mutateCoupledCollabActor(value: RuntimeEvalExecution<CustomAgentRoutingWorld>): void {
  const mutate = (event: unknown) => {
    const candidate = event as Record<string, unknown>;
    if (candidate.type === "collab_spawn_begin" || candidate.type === "collab_spawn_end") {
      candidate.agentType = "incident-operations-liaison";
    }
  };
  value.turns[0]!.coreEvents.forEach((entry) => mutate(entry.event));
  value.turns[0]!.runtimeEvents.forEach(mutate);
  value.turns[0]!.notifications.forEach((notice) => {
    if (notice.method === "agent/event") mutate((notice.params as { event: unknown }).event);
  });
}

function mutateCoupledChildLifecycleId(value: RuntimeEvalExecution<CustomAgentRoutingWorld>): void {
  const mutate = (event: unknown) => {
    const candidate = event as Record<string, unknown>;
    if (candidate.childThreadId && candidate.type !== "collab_spawn_end") candidate.childThreadId = "wrong-child";
  };
  value.turns[0]!.coreEvents.forEach((entry) => mutate(entry.event));
  value.turns[0]!.runtimeEvents.forEach(mutate);
  value.turns[0]!.notifications.forEach((notice) => {
    if (notice.method === "agent/event") mutate((notice.params as { event: unknown }).event);
  });
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

function replaceFirstExactText(value: unknown, expected: string, replacement: string): boolean {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === expected) {
        value[index] = replacement;
        return true;
      }
      if (replaceFirstExactText(value[index], expected, replacement)) return true;
    }
    return false;
  }
  if (typeof value !== "object" || value === null) return false;
  for (const [key, child] of Object.entries(value)) {
    if (child === expected) {
      (value as Record<string, unknown>)[key] = replacement;
      return true;
    }
    if (replaceFirstExactText(child, expected, replacement)) return true;
  }
  return false;
}

function setFinal(value: RuntimeEvalExecution<CustomAgentRoutingWorld>, text: string): void {
  const final = value.turns[0]!.messages.at(-1);
  if (!final || final.role !== "assistant") throw new Error("Missing final assistant response.");
  final.content = [{ type: "text", text }];
}
