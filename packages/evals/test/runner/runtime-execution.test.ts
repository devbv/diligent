// @summary Deterministic end-to-end test for the in-process runtime eval adapter and cleanup

import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AssistantMessage, Message } from "@diligent/core/message-contract";
import type { StreamContext, StreamFunction } from "@diligent/core/provider-contract";
import type { BundledToolProvider } from "@diligent/runtime";
import * as runtime from "@diligent/runtime";
import { z } from "zod";
import { runRuntimeEvalExecution } from "../../src/runner/runtime-execution";
import type { RuntimeEvalExecution, RuntimeEvalTask } from "../../src/runtime-task";
import {
  clarifyThenExecuteTask,
  hookContextFollowTask,
  instructionHierarchyTask,
  type KnowledgeForgetWorld,
  type KnowledgeIntentSplitWorld,
  knowledgeForgetTask,
  knowledgeIntentSplitTask,
  knowledgeRecallTask,
  manualCompactionResumeTask,
  planConvergeTask,
  planToExecuteTask,
  type ReadImagePairWorld,
  readImagePairTask,
  skillAbstainTask,
  skillAutoSelectTask,
} from "../../src/tasks/runtime";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  type RuntimeFixtureWorld,
  seededToken,
  writeFixture,
} from "../../src/tasks/runtime/helpers";
import { assistantMessage, hangingStream, sequenceStream } from "../helpers/fake-stream";

describe("runRuntimeEvalExecution", () => {
  test("uses explicit plugin discovery by default for isolated app-server assembly", async () => {
    const createConfig = spyOn(runtime, "createAppServerConfig");
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-explicit-plugin-discovery",
      description: "thread assembly-only plugin discovery mode",
      fixtureVersion: "explicit-plugin-discovery-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 1, maxToolCalls: 0, timeoutMs: 5_000 },
      toolPolicy: { allowedCapabilities: [], allowedCommands: [] },
      async setup(seed, root) {
        return { root, seed, expected: "done", protectedPaths: [], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "finish" }],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };

    try {
      const result = await runRuntimeEvalExecution({
        task,
        seed: "seed",
        profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
        streamFunction: sequenceStream([assistantMessage([{ type: "text", text: "Done." }])]),
      });

      expect(result.failures).toEqual([]);
      expect(createConfig).toHaveBeenCalledWith(expect.objectContaining({ pluginDiscovery: "explicit" }));
    } finally {
      createConfig.mockRestore();
    }
  });
  test("discovers, advertises, and executes the uniquely matching task-local skill", async () => {
    const seed = "shared-seed-123";
    const ruleToken = seededToken(seed, "HANDOFF_RULE");
    let scripted: StreamFunction | undefined;
    const result = await runRuntimeEvalExecution({
      task: skillAutoSelectTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: (model, context, options) => {
        const cwd = cwdFromContext(context);
        scripted ??= sequenceStream([
          assistantMessage(
            [{ type: "tool_call", id: "select-skill", name: "skill", input: { name: "release-handoff" } }],
            "tool_use",
          ),
          assistantMessage(
            [
              {
                type: "tool_call",
                id: "read-rule",
                name: "read",
                input: {
                  file_path: join(cwd, ".diligent/skills/release-handoff/references/rendering-rule.txt"),
                },
              },
            ],
            "tool_use",
          ),
          assistantMessage(
            [
              {
                type: "tool_call",
                id: "write-handoff",
                name: "apply_patch",
                input: {
                  patch: `*** Begin Patch\n*** Add File: HANDOFF.txt\n+Release capsule: ${ruleToken}\n*** End Patch`,
                },
              },
            ],
            "tool_use",
          ),
          assistantMessage([{ type: "text", text: "Done." }]),
        ]);
        return scripted(model, context, options);
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.execution.toolCalls.map((call) => call.name)).toEqual(["skill", "read", "apply_patch"]);
    expect(result.execution.toolCalls[0]?.input).toEqual({ name: "release-handoff" });
    expect(result.execution.providerCalls[0]?.tools.items).toContainEqual(expect.objectContaining({ name: "skill" }));
    expect(JSON.stringify(result.execution.providerCalls[0]?.systemPrompt.items)).toContain("incident-brief");
  });

  test("advertises irrelevant task-local skills while completing a direct edit without loading them", async () => {
    const seed = "shared-seed-123";
    const requestedContent = `status=${seededToken(seed, "READY")}\n`;
    let scripted: StreamFunction | undefined;
    const result = await runRuntimeEvalExecution({
      task: skillAbstainTask,
      seed,
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: (model, context, options) => {
        const cwd = cwdFromContext(context);
        scripted ??= sequenceStream([
          assistantMessage(
            [
              {
                type: "tool_call",
                id: "write-status",
                name: "edit",
                input: {
                  file_path: join(cwd, "STATUS.txt"),
                  old_string: "",
                  new_string: requestedContent,
                  replace_all: false,
                },
              },
            ],
            "tool_use",
          ),
          assistantMessage([{ type: "text", text: "Done." }]),
        ]);
        return scripted(model, context, options);
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.execution.toolCalls.map((call) => call.name)).toEqual(["edit"]);
    expect(result.execution.advertisedTools[0]?.tools).toContain("skill");
    expect(result.execution.providerCalls[0]?.tools.items).toContainEqual(expect.objectContaining({ name: "skill" }));
    expect(JSON.stringify(result.execution.providerCalls[0]?.systemPrompt.items)).toContain("incident-brief");
  });

  test("compacts, restarts, and resumes with the compacted facts", async () => {
    const seed = "shared-seed-123";
    const alpha = seededToken(seed, "ALPHA");
    const beta = seededToken(seed, "BETA");
    const result = await runRuntimeEvalExecution({
      task: manualCompactionResumeTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: sequenceStream([
        assistantMessage([{ type: "text", text: "ACK" }]),
        assistantMessage([{ type: "text", text: `Retain alpha ${alpha} and beta ${beta} for the resumed task.` }]),
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "patch-context",
              name: "apply_patch",
              input: {
                patch: `*** Begin Patch\n*** Add File: CONTEXT.json\n+{"alpha":"${alpha}","beta":"${beta}"}\n*** End Patch`,
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "Done." }]),
      ]),
    });

    expect(result.failures).toEqual([]);
    expect(result.execution.compactions).toHaveLength(1);
    expect(result.execution.compactions[0]?.response.compacted).toBe(true);
    expect(result.execution.threadReads.map((snapshot) => snapshot.phase)).toEqual([
      "after_turn",
      "after_resume",
      "after_turn",
    ]);
    expect(result.execution.threadReads.every((snapshot) => snapshot.response.isRunning === false)).toBe(true);
    expect(result.execution.session.lines.some((line) => (line as { type?: string }).type === "compaction")).toBe(true);
  });

  test("uses a scripted user-input answer in a later default-mode write", async () => {
    const seed = "shared-seed-123";
    const answer = Number.parseInt(seed.slice(0, 4), 36) % 2 === 0 ? "staging" : "production";
    const desired = seededToken(seed, "CHANNEL");
    const result = await runRuntimeEvalExecution({
      task: clarifyThenExecuteTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: sequenceStream([
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "ask-target",
              name: "request_user_input",
              input: {
                questions: [
                  {
                    id: "deployment_target",
                    header: "Target",
                    question: "Should this update target staging or production?",
                    options: [
                      { label: "Staging", description: "Update the staging channel." },
                      { label: "Production", description: "Update the production channel." },
                    ],
                  },
                ],
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "patch-target",
              name: "apply_patch",
              input: {
                patch:
                  `*** Begin Patch\n*** Update File: deploy/${answer}.channel\n@@\n-channel=stable\n` +
                  `+channel=${desired}\n*** End Patch`,
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "Done." }]),
      ]),
    });

    expect(result.failures).toEqual([]);
    expect(result.execution.userInputRequests).toHaveLength(1);
    expect(result.execution.toolCalls.map((call) => call.name)).toEqual(["request_user_input", "apply_patch"]);
    expect(JSON.stringify(result.execution.session.lines)).toContain(answer);
  });

  test("records original and hook-augmented prompts while following synchronous injected context", async () => {
    const seed = "shared-seed-123";
    const hookFact = seededToken(seed, "HOOK_FACT");
    const result = await runRuntimeEvalExecution({
      task: hookContextFollowTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: sequenceStream([
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "hook-output",
              name: "apply_patch",
              input: { patch: `*** Begin Patch\n*** Add File: HOOK.txt\n+READY:${hookFact}\n*** End Patch` },
            },
          ],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "Done." }]),
      ]),
    });

    expect(result.failures).toEqual([]);
    expect(result.execution.turns[0]?.clientPrompt).not.toContain(hookFact);
    expect(JSON.stringify(result.execution.providerCalls[0]?.messages.items)).toContain(`:${hookFact}`);
    expect(JSON.stringify(result.execution.session.lines)).toContain(`:${hookFact}`);
    expect(result.execution.advertisedTools[0]?.mode).toBe("execute");
    expect(result.execution.toolCalls.map((call) => call.name)).toEqual(["apply_patch"]);
  });

  test("converges in plan mode after exact reads and one scripted bounded question", async () => {
    const seed = "shared-seed-123";
    const apiFact = seededToken(seed, "API_FACT");
    const uiFact = seededToken(seed, "UI_FACT");
    const preference = seededToken(seed, "PREFERENCE");
    let scripted: StreamFunction | undefined;
    const streamFunction: StreamFunction = (model, context, options) => {
      const cwd = cwdFromContext(context);
      scripted ??= sequenceStream([
        assistantMessage(
          [{ type: "tool_call", id: "api-read", name: "read", input: { file_path: `${cwd}/facts/api.txt` } }],
          "tool_use",
        ),
        assistantMessage(
          [{ type: "tool_call", id: "ui-read", name: "read", input: { file_path: `${cwd}/facts/ui.txt` } }],
          "tool_use",
        ),
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "rollout-question",
              name: "request_user_input",
              input: {
                questions: [
                  {
                    id: "rollout_preference",
                    header: "Rollout",
                    question: "Which rollout preference should the plan use?",
                    options: [{ label: "Custom", description: "Supply the unavailable rollout preference." }],
                  },
                ],
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage([
          {
            type: "text",
            text: `<proposed_plan>\n${apiFact}\n${uiFact}\n${preference}\n</proposed_plan>`,
          },
        ]),
      ]);
      return scripted(model, context, options);
    };
    const result = await runRuntimeEvalExecution({
      task: planConvergeTask,
      seed,
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction,
    });

    expect(result.failures).toEqual([]);
    expect(result.execution.toolCalls.map((call) => call.name)).toEqual(["read", "read", "request_user_input"]);
    expect(
      result.execution.providerCalls.every((call) =>
        call.tools.items.every((tool) => {
          const name = "name" in tool ? tool.name : "";
          return ["read", "request_user_input"].includes(name);
        }),
      ),
    ).toBe(true);
    expect(result.execution.advertisedTools[0]?.mode).toBe("plan");
  });

  test("assembles both instruction layers for a nested task cwd and follows their hidden transformations", async () => {
    const seed = "shared-seed-123";
    const target = seededToken(seed, "PAYLOAD");
    const rootMarker = seededToken(seed, "ROOT_RULE");
    const nestedMarker = seededToken(seed, "NESTED_RULE");
    let scripted: StreamFunction | undefined;
    const streamFunction: StreamFunction = (model, context, options) => {
      const cwd = cwdFromContext(context);
      scripted ??= sequenceStream([
        assistantMessage(
          [{ type: "tool_call", id: "target-read", name: "read", input: { file_path: `${cwd}/target.txt` } }],
          "tool_use",
        ),
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "result-write",
              name: "apply_patch",
              input: {
                patch: `*** Begin Patch\n*** Add File: RESULT.txt\n+${rootMarker}[${target}]${nestedMarker}\n*** End Patch`,
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "Done." }]),
      ]);
      return scripted(model, context, options);
    };
    const result = await runRuntimeEvalExecution({
      task: instructionHierarchyTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction,
    });

    expect(result.failures).toEqual([]);
    expect(result.execution.threadCwd).toBe("$WORKSPACE/nested/project");
    const prompt = JSON.stringify(result.execution.providerCalls[0]?.systemPrompt.items);
    expect(prompt).toContain("$WORKSPACE/AGENTS.md");
    expect(prompt).toContain("$WORKSPACE/nested/project/AGENTS.md");
    expect(result.execution.toolCalls.map((call) => call.name)).toEqual(["read", "apply_patch"]);
  });

  test("rejects a second user-input request before the server request is created", async () => {
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-user-input-limit",
      description: "enforce user-input limit before dispatch",
      fixtureVersion: "user-input-limit-v0",
      limits: {
        ...DEFAULT_RUNTIME_LIMITS,
        maxTurns: 3,
        maxToolCalls: 2,
        maxUserInputRequests: 1,
        timeoutMs: 5_000,
      },
      toolPolicy: { allowedCapabilities: ["user_input"], allowedCommands: [] },
      async setup(seed, root) {
        return { root, seed, expected: "answer", protectedPaths: [], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "ask twice" }],
      respondToServerRequest: (_world, request) =>
        ({
          method: request.method,
          result: { answers: { choice: "answer" } },
        }) as never,
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };
    const question = {
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Which value should be used?",
          options: [{ label: "Answer", description: "Use the scripted answer." }],
        },
      ],
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: sequenceStream([
        assistantMessage([{ type: "tool_call", id: "ask-1", name: "request_user_input", input: question }], "tool_use"),
        assistantMessage([{ type: "tool_call", id: "ask-2", name: "request_user_input", input: question }], "tool_use"),
        assistantMessage([{ type: "text", text: "Done." }]),
      ]),
    });

    expect(result.execution.userInputRequests).toHaveLength(1);
    expect(result.passed).toBe(false);
    expect(result.execution.termination).toBe("user_input_limit");
    expect(result.failures.map((failure) => failure.code)).toContain("budget_exceeded.user_input_limit");
    expect(
      result.execution.toolCalls.filter((trace) => trace.name === "request_user_input").map((trace) => trace.outcome),
    ).toEqual(["success", "policy_rejection"]);
  });

  test("rejects a second spawn before another child session is created", async () => {
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-child-agent-limit",
      description: "enforce child-agent limit before spawn",
      fixtureVersion: "child-agent-limit-v0",
      limits: {
        ...DEFAULT_RUNTIME_LIMITS,
        maxTurns: 6,
        maxToolCalls: 3,
        maxChildAgents: 1,
        timeoutMs: 10_000,
      },
      toolPolicy: { allowedTools: ["spawn_agent", "wait"], allowedCapabilities: ["collab"], allowedCommands: [] },
      async setup(seed, root) {
        return { root, seed, expected: "child", protectedPaths: [], allowedChanges: [] };
      },
      async createRuntimeConfig(world, profile) {
        const config = await createFixtureRuntimeConfig(world, profile);
        return { ...config, diligent: { ...config.diligent, agents: { enabled: true } } };
      },
      createSteps: () => [{ kind: "turn", message: "spawn twice, then wait for the first child" }],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };
    let parentPhase = 0;
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: (model, context, options) => {
        const child = context.systemPrompt.some((section) => section.label === "nested_subagent_policy");
        if (child)
          return sequenceStream([assistantMessage([{ type: "text", text: "child done" }])])(model, context, options);
        const results = context.messages.filter((message) => message.role === "tool_result") as Array<
          Message & { role: "tool_result"; toolName: string; output: string }
        >;
        let response: AssistantMessage;
        if (parentPhase < 2) {
          parentPhase += 1;
          response = assistantMessage(
            [
              {
                type: "tool_call",
                id: `spawn-${parentPhase}`,
                name: "spawn_agent",
                input: {
                  message: "Return child done.",
                  description: "bounded child",
                  agent_type: "general",
                  allowed_tools: ["read"],
                },
              },
            ],
            "tool_use",
          );
        } else if (parentPhase === 2) {
          parentPhase += 1;
          const firstSpawn = results.find(
            (message) => message.toolName === "spawn_agent" && !message.output.startsWith("Error:"),
          );
          if (!firstSpawn) throw new Error("Missing first spawn result.");
          const { thread_id } = JSON.parse(firstSpawn.output) as { thread_id: string };
          response = assistantMessage(
            [{ type: "tool_call", id: "wait-1", name: "wait", input: { ids: [thread_id], timeout_ms: 5_000 } }],
            "tool_use",
          );
        } else response = assistantMessage([{ type: "text", text: "Done." }]);
        return sequenceStream([response])(model, context, options);
      },
    });

    expect(result.execution.childSessions).toHaveLength(1);
    expect(result.passed).toBe(false);
    expect(result.execution.termination).toBe("child_agent_limit");
    expect(result.failures.map((failure) => failure.code)).toContain("budget_exceeded.child_agent_limit");
    expect(
      result.execution.toolCalls.filter((trace) => trace.name === "spawn_agent").map((trace) => trace.outcome),
    ).toEqual(["success", "policy_rejection"]);
  });

  test("aggregates semantic failure with a completed execution invariant failure", async () => {
    let fixtureRoot = "";
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-semantic-and-invariant-failure",
      description: "aggregate completed evidence failures",
      fixtureVersion: "semantic-and-invariant-v0",
      limits: {
        ...DEFAULT_RUNTIME_LIMITS,
        maxTurns: 2,
        maxToolCalls: 1,
        maxChangedFiles: 1,
        timeoutMs: 5_000,
      },
      toolPolicy: { allowedCapabilities: ["write"], allowedCommands: [] },
      async setup(seed, root) {
        fixtureRoot = root;
        await writeFixture(root, { "PROTECTED.txt": "original\n" });
        return { root, seed, expected: "expected", protectedPaths: ["PROTECTED.txt"], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "write the wrong result" }],
      snapshotWorld: async () => ({}),
      evaluate: () => ({
        passed: false,
        code: "wrong_result",
        message: "The result was semantically wrong.",
        dimension: "semantic_goal",
      }),
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: (() => {
        let call = 0;
        return (model, context, options) =>
          sequenceStream([
            call++ === 0
              ? assistantMessage(
                  [
                    {
                      type: "tool_call",
                      id: "unexpected-write",
                      name: "edit",
                      input: {
                        file_path: join(fixtureRoot, "PROTECTED.txt"),
                        old_string: "original\n",
                        new_string: "wrong\n",
                      },
                    },
                  ],
                  "tool_use",
                )
              : assistantMessage([{ type: "text", text: "Done." }]),
          ])(model, context, options);
      })(),
    });

    expect(result.execution.termination).toBe("completed");
    expect(result.failures.map((failure) => failure.code)).toContain("runtime_contract.protected_file_changed");
    expect(result.failures.map((failure) => failure.code)).toContain("task_semantic.wrong_result");
  });

  test("preserves completed evidence when the semantic evaluator throws", async () => {
    let fixtureRoot = "";
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-evaluator-error",
      description: "preserve execution evidence after an evaluator defect",
      fixtureVersion: "evaluator-error-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 1, maxToolCalls: 0, timeoutMs: 5_000 },
      toolPolicy: { allowedCapabilities: [], allowedCommands: [] },
      async setup(seed, root) {
        fixtureRoot = root;
        return { root, seed, expected: "done", protectedPaths: [], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "finish directly" }],
      snapshotWorld: async () => ({ preserved: true }),
      evaluate: () => {
        throw new Error(`broken evaluator under ${fixtureRoot}`);
      },
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: "Done." }])]),
    });

    expect(result.execution.termination).toBe("completed");
    expect(result.execution.turns).toHaveLength(1);
    expect(result.execution.session.lines.length).toBeGreaterThan(1);
    expect(result.worldSnapshot).toEqual({ preserved: true });
    expect(result.failures).toContainEqual({
      dimension: "harness_terminal",
      category: "evaluator_error",
      code: "evaluator_error.exception",
      message: "broken evaluator under $WORKSPACE",
    });
  });

  test("classifies a runtime evaluator result missing its required dimension as evaluator_error", async () => {
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-missing-dimension",
      description: "defend against an untyped evaluator result",
      fixtureVersion: "missing-dimension-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 1, maxToolCalls: 0, timeoutMs: 5_000 },
      toolPolicy: { allowedCapabilities: [], allowedCommands: [] },
      async setup(seed, root) {
        return { root, seed, expected: "done", protectedPaths: [], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "finish directly" }],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: false, code: "wrong", message: "wrong" }) as never,
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: "Done." }])]),
    });

    expect(result.failure).toMatchObject({
      dimension: "harness_terminal",
      category: "evaluator_error",
      code: "evaluator_error.missing_dimension",
    });
  });

  test("executes the plan-to-default task and verifies its exact implementation", async () => {
    const seed = "shared-seed-123";
    const token = seededToken(seed, "CONTRACT");
    const multiplier = (Number.parseInt(seed.slice(0, 4), 36) % 5) + 2;
    const offset = (Number.parseInt(seed.slice(4, 8), 36) % 13) + 1;
    let scripted: StreamFunction | undefined;
    const result = await runRuntimeEvalExecution({
      task: planToExecuteTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: (model, context, options) => {
        const cwd = cwdFromContext(context);
        scripted ??= sequenceStream([
          assistantMessage(
            [
              {
                type: "tool_call",
                id: "read-contract",
                name: "read",
                input: { file_path: join(cwd, "spec/private-contract.txt") },
              },
            ],
            "tool_use",
          ),
          assistantMessage([{ type: "text", text: `Contract ${token}: return value * ${multiplier} + ${offset}.` }]),
          assistantMessage(
            [
              {
                type: "tool_call",
                id: "patch-1",
                name: "apply_patch",
                input: {
                  patch: `*** Begin Patch\n*** Update File: src/value.ts\n@@\n export function adjustValue(value: number): number {\n-  return value;\n+  return value * ${multiplier} + ${offset};\n }\n*** End Patch`,
                },
              },
            ],
            "tool_use",
          ),
          assistantMessage(
            [{ type: "tool_call", id: "bash-1", name: "bash", input: { command: "bun test" } }],
            "tool_use",
          ),
          assistantMessage([{ type: "text", text: "Implemented and verified." }]),
        ]);
        return scripted(model, context, options);
      },
    });

    expect(result.passed).toBe(true);
    expect(result.execution.turns).toHaveLength(2);
    expect(result.execution.turns[0]?.clientPrompt).toContain("project specification");
    expect(result.execution.turns[1]?.clientPrompt).toContain("specification source has now been withdrawn");
    expect(result.execution.toolCalls.map((call) => call.name)).toEqual(["read", "apply_patch", "bash"]);
  });

  test("executes the knowledge-recall task through the assembled runtime", async () => {
    const seed = "shared-seed-123";
    const token = seededToken(seed, "CHANNEL");
    const result = await runRuntimeEvalExecution({
      task: knowledgeRecallTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: sequenceStream([
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "patch-1",
              name: "apply_patch",
              input: {
                patch: `*** Begin Patch\n*** Add File: RELEASE.txt\n+${token}\n*** End Patch`,
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "Done." }]),
      ]),
    });

    expect(result.passed).toBe(true);
    expect(result.execution.toolCalls.map((call) => call.name)).toEqual(["apply_patch"]);
  });

  test("executes intent splitting with OpenAI-native creation and transient-free knowledge", async () => {
    const seed = "shared-seed-123";
    const knowledgeId = "preference.review-audience";
    const durableValue = seededToken(seed, "AUDIENCE");
    const transientValue = seededToken(seed, "CURRENT");
    const content = `Preferred review audience is ${durableValue}.`;
    const result = await runRuntimeEvalExecution({
      task: knowledgeIntentSplitTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: sequenceStream([
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "split-search-prefix",
              name: "search_knowledge",
              input: { id_prefix: knowledgeId },
            },
            {
              type: "tool_call",
              id: "split-search-query",
              name: "search_knowledge",
              input: { query: "review audience" },
            },
          ],
          "tool_use",
        ),
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "split-update",
              name: "update_knowledge",
              input: {
                action: "upsert",
                id: knowledgeId,
                type: "preference",
                content,
                tags: ["review", "audience"],
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "split-write",
              name: "apply_patch",
              input: {
                patch: `*** Begin Patch\n*** Add File: CURRENT.txt\n+${transientValue}\n*** End Patch`,
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "Done." }]),
      ]),
    });

    const execution = result.execution as RuntimeEvalExecution<KnowledgeIntentSplitWorld>;
    const verification = JSON.parse(execution.verifier?.stdout ?? "{}") as {
      entry?: { id?: string; type?: string; content?: string; tags?: string[] };
      outputHash?: string;
    };
    expect(result.failures).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        dimension: "efficiency",
        code: "knowledge_intent_split.second_safe_search",
        message: "A second bounded read-only knowledge search was used before successful completion.",
      },
    ]);
    expect(result.execution.toolCalls.map((call) => [call.name, call.outcome])).toEqual([
      ["search_knowledge", "success"],
      ["search_knowledge", "success"],
      ["update_knowledge", "success"],
      ["apply_patch", "success"],
    ]);
    expect(result.execution.verifier?.exitCode).toBe(0);
    expect(result.execution.runtimeState.diff.some((change) => change.category === "knowledge")).toBe(true);
    expect(verification.entry).toMatchObject({
      id: knowledgeId,
      type: "preference",
      content,
      tags: ["review", "audience"],
    });
    expect(JSON.stringify(verification.entry)).not.toContain(transientValue);
    expect(verification.outputHash).toBe(execution.world.expectedHash);
    expect(execution.workspace.final.entries).toContainEqual(
      expect.objectContaining({ path: "CURRENT.txt", sha256: execution.world.expectedHash }),
    );
    expect(execution.world.expected).not.toContain(durableValue);
  });

  test("executes forgetting with Anthropic-native creation while preserving control knowledge", async () => {
    const seed = "shared-seed-123";
    const knowledgeId = "preference.deploy-window";
    const taskValue = seededToken(seed, "FORGET_TASK");
    let scripted: StreamFunction | undefined;
    const result = await runRuntimeEvalExecution({
      task: knowledgeForgetTask,
      seed,
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: (model, context, options) => {
        const cwd = cwdFromContext(context);
        scripted ??= sequenceStream([
          assistantMessage(
            [{ type: "tool_call", id: "forget-search", name: "search_knowledge", input: { id: knowledgeId } }],
            "tool_use",
          ),
          assistantMessage(
            [
              {
                type: "tool_call",
                id: "forget-delete",
                name: "update_knowledge",
                input: { action: "delete", id: knowledgeId },
              },
            ],
            "tool_use",
          ),
          assistantMessage(
            [
              {
                type: "tool_call",
                id: "forget-write",
                name: "edit",
                input: {
                  file_path: join(cwd, "FORGET.txt"),
                  old_string: "",
                  new_string: `${taskValue}\n`,
                  replace_all: false,
                },
              },
            ],
            "tool_use",
          ),
          assistantMessage([{ type: "text", text: "Done." }]),
        ]);
        return scripted(model, context, options);
      },
    });

    const execution = result.execution as RuntimeEvalExecution<KnowledgeForgetWorld>;
    const verification = JSON.parse(execution.verifier?.stdout ?? "{}") as {
      entries?: unknown[];
      outputHash?: string;
    };
    expect(result.failures).toEqual([]);
    expect(result.execution.toolCalls.map((call) => [call.name, call.outcome])).toEqual([
      ["search_knowledge", "success"],
      ["update_knowledge", "success"],
      ["edit", "success"],
    ]);
    expect(result.execution.toolCalls[1]?.input).toEqual({ action: "delete", id: knowledgeId });
    expect(result.execution.verifier?.exitCode).toBe(0);
    expect(result.execution.runtimeState.diff.some((change) => change.category === "knowledge")).toBe(true);
    expect(verification.entries).toEqual([execution.world.controlEntry]);
    expect(JSON.stringify(verification.entries)).not.toContain(execution.world.forgottenValue);
    expect(verification.outputHash).toBe(execution.world.expectedHash);
    expect(execution.workspace.final.entries).toContainEqual(
      expect.objectContaining({ path: "FORGET.txt", sha256: execution.world.expectedHash }),
    );
  });

  test("reads a seed-swapped image pair while keeping transport mechanics outside live scoring", async () => {
    const seed = "shared-seed-123";
    const swap = createHash("sha256").update(seed).digest()[0]! % 2 === 1;
    const expected = swap ? "A=BLUE; B=RED" : "A=RED; B=BLUE";
    const result = await runRuntimeEvalExecution({
      task: readImagePairTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: imagePairStream(expected),
    });

    const sessionEvidence = JSON.stringify(result.execution.session.lines);
    const capturedBlobHashes = [
      ...new Set([...sessionEvidence.matchAll(/blob:([0-9a-f]{64})/g)].map((match) => match[1]!)),
    ];
    expect(result.failures).toEqual([]);
    expect(result.execution.toolCalls.map((call) => call.toolCallId)).toEqual(["image-a", "image-b"]);
    expect(capturedBlobHashes).toHaveLength(2);
    for (const hash of capturedBlobHashes) {
      expect(sessionEvidence).toContain(`blob:${hash}`);
      expect(result.execution.runtimeState.final).toContainEqual(
        expect.objectContaining({ path: `.diligent/sessions/blobs/${hash}.bin`, category: "image_sidecars" }),
      );
      expect(result.execution.runtimeState.diff).toContainEqual({
        path: `.diligent/sessions/blobs/${hash}.bin`,
        category: "image_sidecars",
        change: "added",
      });
    }
    expect(sessionEvidence).not.toContain("iVBOR");
    expect(JSON.stringify(result.execution)).not.toContain("iVBOR");
    expect(JSON.stringify(result.execution)).toContain("[base64 omitted]");

    const withoutRuntimeImages = structuredClone(result.execution);
    for (const turn of withoutRuntimeImages.turns) {
      turn.runtimeEvents = turn.runtimeEvents.map((event) => {
        const item = event as { type?: string; toolName?: string; outputImages?: unknown };
        if (item.type !== "tool_end" || item.toolName !== "read_image") return event;
        const { outputImages: _omitted, ...rest } = item;
        return rest;
      });
    }
    expect(readImagePairTask.evaluate(withoutRuntimeImages as RuntimeEvalExecution<ReadImagePairWorld>)).toEqual({
      passed: true,
    });
  });

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
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
    });

    expect(result.passed).toBe(true);
    expect(result.execution.turns).toHaveLength(1);
    expect(result.execution.session.lines.length).toBeGreaterThan(2);
    expect(JSON.stringify({ ...result.execution, world: null })).not.toContain(fixtureRoot);
    expect(existsSync(fixtureRoot)).toBe(false);
  });

  test("uses a validated nested thread cwd while keeping workspace evidence rooted at the fixture", async () => {
    type NestedWorld = RuntimeFixtureWorld & { threadCwd: string };
    let nestedCwd = "";
    const task: RuntimeEvalTask<NestedWorld> = {
      id: "runtime-nested-cwd",
      description: "nested cwd",
      fixtureVersion: "nested-cwd-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 2, maxToolCalls: 1, timeoutMs: 5_000 },
      toolPolicy: { allowedCapabilities: ["write"], allowedCommands: [] },
      async setup(seed, root) {
        const threadCwd = join(root, "nested", "project");
        nestedCwd = threadCwd;
        await mkdir(threadCwd, { recursive: true });
        await writeFixture(root, { "ROOT.txt": "protected\n", "nested/project/RESULT.txt": "old\n" });
        return {
          root,
          threadCwd,
          seed,
          expected: "nested",
          protectedPaths: ["ROOT.txt"],
          allowedChanges: ["nested/project/RESULT.txt"],
        };
      },
      resolveThreadCwd: (world) => world.threadCwd,
      createRuntimeConfig: (world, profile) => createFixtureRuntimeConfig({ ...world, root: world.threadCwd }, profile),
      createSteps: () => [{ kind: "turn", message: "write" }],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: (() => {
        let call = 0;
        return (model, context, options) =>
          sequenceStream([
            call++ === 0
              ? assistantMessage(
                  [
                    {
                      type: "tool_call",
                      id: "write-1",
                      name: "edit",
                      input: { file_path: `${nestedCwd}/RESULT.txt`, old_string: "old\n", new_string: "nested\n" },
                    },
                  ],
                  "tool_use",
                )
              : assistantMessage([{ type: "text", text: "done" }]),
          ])(model, context, options);
      })(),
    });

    expect(result.failures).toEqual([]);
    expect(result.execution.threadCwd).toBe("$WORKSPACE/nested/project");
    expect(
      result.execution.workspace.initial.entries.find((entry) => entry.path === "nested/project/RESULT.txt")?.sha256,
    ).not.toBe(
      result.execution.workspace.final.entries.find((entry) => entry.path === "nested/project/RESULT.txt")?.sha256,
    );
    expect(result.execution.threadReads[0]?.response.cwd).toBe("$WORKSPACE/nested/project");
  });

  test("rejects a task-selected thread cwd outside the fixture before runtime startup", async () => {
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-escaped-cwd",
      description: "escaped cwd",
      fixtureVersion: "escaped-cwd-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 1, maxToolCalls: 0, timeoutMs: 5_000 },
      toolPolicy: { allowedCapabilities: [], allowedCommands: [] },
      async setup(seed, root) {
        return { root, seed, expected: "", protectedPaths: [], allowedChanges: [] };
      },
      resolveThreadCwd: (_world, fixtureRoot) => join(fixtureRoot, ".."),
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "unused" }],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: "unused" }])]),
    });

    expect(result.passed).toBe(false);
    expect(result.failure).toMatchObject({
      category: "configuration",
      code: "configuration.invalid_thread_cwd",
    });
    expect(result.execution.turns).toEqual([]);
  });

  test("supplies fixture-owned bundled providers outside RuntimeConfig and records tools before policy filtering", async () => {
    let runtimeConfigHadProviders = false;
    const provider: BundledToolProvider = {
      id: "fixture-provider",
      createTools: () => [
        {
          name: "fixture_receipt",
          description: "Return a fixture receipt",
          parameters: z.object({ value: z.string() }),
          execute: async ({ value }) => ({ output: `receipt:${value}` }),
        },
      ],
    };
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-bundled-provider",
      description: "bundled provider",
      fixtureVersion: "bundled-provider-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 2, maxToolCalls: 1, timeoutMs: 5_000 },
      toolPolicy: { allowedTools: ["fixture_receipt"], allowedCapabilities: ["execute"], allowedCommands: [] },
      async setup(seed, root) {
        return { root, seed, expected: "value", protectedPaths: [], allowedChanges: [] };
      },
      async createRuntimeConfig(world, profile) {
        const config = await createFixtureRuntimeConfig(world, profile);
        runtimeConfigHadProviders = "bundledToolProviders" in config;
        return config;
      },
      createBundledToolProviders: () => [provider],
      createSteps: () => [{ kind: "turn", message: "receipt" }],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: sequenceStream([
        assistantMessage(
          [{ type: "tool_call", id: "receipt-1", name: "fixture_receipt", input: { value: "value" } }],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "done" }]),
      ]),
    });

    expect(result.failures).toEqual([]);
    expect(runtimeConfigHadProviders).toBe(false);
    expect(result.execution.toolCalls[0]?.output).toEqual({ output: "receipt:value" });
    expect(result.execution.advertisedTools[0]).toMatchObject({
      mode: "default",
      provider: "anthropic",
      cwd: "$WORKSPACE",
    });
    expect(result.execution.advertisedTools[0]?.tools).toContain("fixture_receipt");
    expect(result.execution.advertisedTools[0]?.tools).toContain("read");
  });

  test("fires one bounded steer action after a matching tool_end and records protocol evidence", async () => {
    const steering = "Use the replacement requirement.";
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-steer-action",
      description: "steer action",
      fixtureVersion: "steer-action-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 3, maxToolCalls: 2, timeoutMs: 5_000 },
      toolPolicy: { allowedCapabilities: ["read"], allowedCommands: [] },
      async setup(seed, root) {
        await writeFixture(root, { "value.txt": "value\n" });
        return { root, seed, expected: steering, protectedPaths: ["value.txt"], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [
        {
          kind: "turn",
          message: "read",
          actions: [
            {
              id: "steer-after-read",
              timeoutMs: 1_000,
              trigger: {
                source: "runtime_event",
                eventType: "tool_end",
                toolName: "read",
                isError: false,
                occurrence: 1,
              },
              request: { method: "turn/steer", params: { content: steering, steerId: "eval-steer-1" } },
            },
          ],
        },
      ],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };
    let providerCall = 0;
    let scripted: StreamFunction | undefined;
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: (_model, context, options) => {
        providerCall += 1;
        if (providerCall === 3) {
          expect(context.messages.some((message) => JSON.stringify(message).includes(steering))).toBe(true);
        }
        const cwd = cwdFromContext(context);
        scripted ??= sequenceStream([
          assistantMessage(
            [{ type: "tool_call", id: "read-relative", name: "read", input: { file_path: "value.txt" } }],
            "tool_use",
          ),
          assistantMessage(
            [{ type: "tool_call", id: "read-absolute", name: "read", input: { file_path: join(cwd, "value.txt") } }],
            "tool_use",
          ),
          assistantMessage([{ type: "text", text: "steered" }]),
        ]);
        return scripted(_model, context, options);
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.execution.protocolActions).toHaveLength(1);
    expect(result.execution.protocolActions[0]).toMatchObject({
      id: "steer-after-read",
      status: "completed",
      triggerCount: 1,
      trigger: { eventType: "tool_end", toolName: "read", isError: false },
      request: { method: "turn/steer", params: { content: steering, steerId: "eval-steer-1" } },
      response: { queued: true, steerId: "eval-steer-1" },
    });
    expect(result.execution.protocolActions[0]?.triggerEvidence).toMatchObject({
      type: "tool_end",
      toolName: "read",
      toolCallId: "read-absolute",
      isError: false,
    });
    expect(result.execution.toolCalls.map((call) => call.outcome)).toEqual(["runtime_error", "success"]);
  });

  test("fails deterministically when a declared protocol action trigger is missing", async () => {
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-missing-action",
      description: "missing action",
      fixtureVersion: "missing-action-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 1, maxToolCalls: 0, timeoutMs: 5_000 },
      toolPolicy: { allowedCapabilities: [], allowedCommands: [] },
      async setup(seed, root) {
        return { root, seed, expected: "", protectedPaths: [], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [
        {
          kind: "turn",
          message: "reply",
          actions: [
            {
              id: "never-fired",
              timeoutMs: 100,
              trigger: { source: "runtime_event", eventType: "tool_end", toolName: "read" },
              request: { method: "turn/steer", params: { content: "unused" } },
            },
          ],
        },
      ],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.code === "runtime_contract.protocol_action_missing_trigger")).toBe(
      true,
    );
    expect(result.execution.protocolActions[0]?.status).toBe("missing_trigger");
  });

  test("sends an action once but fails when its matching trigger repeats", async () => {
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-repeated-action",
      description: "repeated action",
      fixtureVersion: "repeated-action-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 3, maxToolCalls: 2, timeoutMs: 5_000 },
      toolPolicy: { allowedCapabilities: ["read"], allowedCommands: [] },
      async setup(seed, root) {
        await writeFixture(root, { "value.txt": "value\n" });
        return { root, seed, expected: "", protectedPaths: ["value.txt"], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [
        {
          kind: "turn",
          message: "read twice",
          actions: [
            {
              id: "one-read-only",
              timeoutMs: 1_000,
              trigger: { source: "runtime_event", eventType: "tool_end", toolName: "read" },
              request: { method: "turn/steer", params: { content: "continue", steerId: "one-read-steer" } },
            },
          ],
        },
      ],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: sequenceStream([
        assistantMessage(
          [{ type: "tool_call", id: "read-1", name: "read", input: { file_path: "value.txt" } }],
          "tool_use",
        ),
        assistantMessage(
          [{ type: "tool_call", id: "read-2", name: "read", input: { file_path: "value.txt" } }],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "done" }]),
      ]),
    });

    expect(result.passed).toBe(false);
    expect(
      result.failures.some((failure) => failure.code === "runtime_contract.protocol_action_repeated_trigger"),
    ).toBe(true);
    expect(result.execution.protocolActions[0]).toMatchObject({
      status: "repeated_trigger",
      triggerCount: 2,
      response: { queued: true, steerId: "one-read-steer" },
    });
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
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: hangingStream(),
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.code === "budget_exceeded.timeout")).toBe(true);
    expect(result.execution.termination).toBe("timeout");
  });

  test("starts the root deadline before setup and passes its abort signal", async () => {
    let fixtureRoot = "";
    let observedAbort = false;
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-setup-timeout",
      description: "bound setup",
      fixtureVersion: "setup-timeout-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 1, maxToolCalls: 0, timeoutMs: 40 },
      toolPolicy: { allowedCapabilities: [], allowedCommands: [] },
      async setup(_seed, root, signal) {
        fixtureRoot = root;
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        return { root, seed: "seed", expected: "", protectedPaths: [], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };

    const started = performance.now();
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: hangingStream(),
    });

    expect(observedAbort).toBe(true);
    expect(result.execution.termination).toBe("timeout");
    expect(result.failures.filter((failure) => failure.code === "budget_exceeded.timeout")).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(750);
    expect(existsSync(fixtureRoot)).toBe(false);
  });

  test("bounds a verifier that ignores abort with its smaller phase timeout", async () => {
    let fixtureRoot = "";
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-verifier-timeout",
      description: "bound verifier",
      fixtureVersion: "verifier-timeout-v0",
      limits: {
        ...DEFAULT_RUNTIME_LIMITS,
        maxTurns: 1,
        maxToolCalls: 0,
        timeoutMs: 1_000,
        verifierTimeoutMs: 40,
      },
      toolPolicy: { allowedCapabilities: [], allowedCommands: [] },
      async setup(seed, root) {
        fixtureRoot = root;
        return { root, seed, expected: "", protectedPaths: [], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "finish" }],
      verify: async () => new Promise<never>(() => undefined),
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };

    const started = performance.now();
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: "Done." }])]),
    });

    expect(result.execution.termination).toBe("runner_error");
    expect(result.failures[0]?.code).toBe("runner_error.verifier_timeout");
    expect(performance.now() - started).toBeLessThan(750);
    expect(existsSync(fixtureRoot)).toBe(false);
  });

  test("applies the root deadline to snapshotWorld even when it ignores abort", async () => {
    let fixtureRoot = "";
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-snapshot-timeout",
      description: "bound snapshot",
      fixtureVersion: "snapshot-timeout-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 1, maxToolCalls: 0, timeoutMs: 60 },
      toolPolicy: { allowedCapabilities: [], allowedCommands: [] },
      async setup(seed, root) {
        fixtureRoot = root;
        return { root, seed, expected: "", protectedPaths: [], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "finish" }],
      snapshotWorld: async () => new Promise<never>(() => undefined),
      evaluate: () => ({ passed: true }),
    };

    const started = performance.now();
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: "Done." }])]),
    });

    expect(result.execution.termination).toBe("timeout");
    expect(result.failures.filter((failure) => failure.code === "budget_exceeded.timeout")).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(750);
    expect(existsSync(fixtureRoot)).toBe(false);
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
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: (...args) => {
        providerCalls += 1;
        return messages(...args);
      },
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.code === "budget_exceeded.turn_limit")).toBe(true);
    expect(providerCalls).toBe(1);
  });

  test("captures initial and post-tool provider context with session, prompt, and tool evidence", async () => {
    let fixtureRoot = "";
    const imageData = "runtime-provider-secret-base64";
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-provider-call-evidence",
      description: "capture effective provider context",
      fixtureVersion: "provider-call-evidence-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 2, maxToolCalls: 1, timeoutMs: 5_000 },
      statePolicy: { allowedMutations: ["infrastructure", "sessions", "image_sidecars"] },
      toolPolicy: { allowedTools: ["provider_evidence_tool"], allowedCapabilities: ["execute"], allowedCommands: [] },
      async setup(seed, root) {
        fixtureRoot = root;
        return { root, seed, expected: "evidence", protectedPaths: [], allowedChanges: [] };
      },
      async createRuntimeConfig(world, profile) {
        const config = await createFixtureRuntimeConfig(world, profile);
        config.systemPrompt = [
          { label: "base", content: `Fixture root: ${world.root}` },
          { tag: "fixture", label: "provider_fixture", content: "Provider evidence section" },
        ];
        return config;
      },
      createBundledToolProviders: () => [
        {
          id: "provider-evidence",
          createTools: () => [
            {
              name: "provider_evidence_tool",
              description: "Return structured provider evidence",
              parameters: z.object({ value: z.string() }),
              execute: async () =>
                ({
                  output: "tool evidence",
                  outputImages: [
                    { type: "image", source: { type: "base64", media_type: "image/png", data: imageData } },
                  ],
                }) as never,
            },
          ],
        },
      ],
      createSteps: () => [{ kind: "turn", message: "Use the evidence tool." }],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "provider-seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: sequenceStream([
        assistantMessage(
          [{ type: "tool_call", id: "provider-evidence", name: "provider_evidence_tool", input: { value: "x" } }],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "Done." }]),
      ]),
    });

    expect(result.failures).toEqual([]);
    expect(result.execution.providerCalls.map((call) => call.sequence)).toEqual([1, 2]);
    expect(result.execution.providerCalls.map((call) => call.sessionId)).toEqual([
      result.execution.session.threadId,
      result.execution.session.threadId,
    ]);
    expect(result.execution.providerCalls[0]?.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5" });
    expect(result.execution.providerCalls[0]?.systemPrompt.items).toContainEqual({
      content: "Fixture root: $WORKSPACE",
      label: "base",
    });
    expect(result.execution.providerCalls[0]?.tools.items).toContainEqual(
      expect.objectContaining({ kind: "function", name: "provider_evidence_tool" }),
    );
    expect(result.execution.providerCalls[0]?.tools.items[0]).toEqual(
      expect.objectContaining({ inputSchema: expect.objectContaining({ type: "object" }) }),
    );
    expect(result.execution.providerCalls[0]?.messages.totalCount).toBe(1);
    expect(result.execution.providerCalls[1]?.messages.totalCount).toBeGreaterThan(1);
    expect(JSON.stringify(result.execution.providerCalls)).toContain("[base64 omitted]");
    expect(JSON.stringify(result.execution)).not.toContain(imageData);
    expect(JSON.stringify(result.execution.providerCalls)).not.toContain(fixtureRoot);
  });

  test("bounds provider source collections and reports original counts and omissions", async () => {
    const sourceCount = 70;
    const toolNames = Array.from(
      { length: sourceCount },
      (_, index) => `bounded_tool_${String(index).padStart(2, "0")}`,
    );
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-provider-evidence-bounds",
      description: "bound provider evidence sources",
      fixtureVersion: "provider-evidence-bounds-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 1, maxToolCalls: 0, timeoutMs: 5_000 },
      toolPolicy: { allowedTools: toolNames, allowedCapabilities: ["execute"], allowedCommands: [] },
      async setup(seed, root) {
        return { root, seed, expected: "bounded", protectedPaths: [], allowedChanges: [] };
      },
      async createRuntimeConfig(world, profile) {
        const config = await createFixtureRuntimeConfig(world, profile);
        config.systemPrompt = Array.from({ length: sourceCount }, (_, index) => ({
          label: `section_${index}`,
          content: index === 0 ? "x".repeat(9_000) : `section ${index}`,
        }));
        return config;
      },
      createBundledToolProviders: () => [
        {
          id: "bounded-tools",
          createTools: () =>
            toolNames.map((name) => ({
              name,
              description: name,
              parameters: z.object({}),
              execute: async () => ({ output: "unused" }),
            })),
        },
      ],
      createSteps: () => [{ kind: "turn", message: "Finish without tools." }],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "bounded-seed",
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: "Done." }])]),
    });

    const call = result.execution.providerCalls[0]!;
    expect(call.systemPrompt).toMatchObject({ totalCount: sourceCount, includedCount: 64, omittedCount: 6 });
    expect(call.tools).toMatchObject({ totalCount: sourceCount, includedCount: 64, omittedCount: 6 });
    expect(call.bounds.truncatedStrings).toBeGreaterThan(0);
    expect(JSON.stringify(call).length).toBeLessThan(700_000);
  });

  test("isolates full tool outputs behind exact registered reads and removes the output root", async () => {
    const hidden = "HIDDEN-FULL-OUTPUT-FACT";
    const renderOnlySentinel = "REGISTERED-RENDER-CONTENT-MUST-BE-OMITTED";
    const projectRenderContent = "PROJECT-RENDER-CONTENT-MUST-REMAIN";
    const largeOutput = Array.from({ length: 600 }, (_, index) => {
      if (index === 450) return renderOnlySentinel;
      if (index === 500) return hidden;
      return `fixture-line-${String(index + 1).padStart(3, "0")}-${"x".repeat(24)}`;
    }).join("\n");
    const task = createFullOutputTask(largeOutput);
    let fullOutputPath = "";
    let phase = 0;
    const result = await runRuntimeEvalExecution({
      task,
      seed: "full-output-seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: (model, context, options) => {
        if (phase++ === 0) {
          return sequenceStream([
            assistantMessage(
              [{ type: "tool_call", id: "large-output", name: "large_fixture_output", input: {} }],
              "tool_use",
            ),
          ])(model, context, options);
        }
        const savedResult = context.messages.findLast(
          (message) => message.role === "tool_result" && message.toolName === "large_fixture_output",
        ) as (Message & { metadata?: { fullOutputPath?: string } }) | undefined;
        if (!fullOutputPath) {
          fullOutputPath = savedResult?.metadata?.fullOutputPath ?? "";
          return sequenceStream([
            assistantMessage(
              [
                {
                  type: "tool_call",
                  id: "read-exact",
                  name: "read",
                  input: { file_path: fullOutputPath, offset: 501, limit: 1 },
                },
                {
                  type: "tool_call",
                  id: "read-project",
                  name: "read",
                  input: { file_path: join(cwdFromContext(context), "project-render.txt") },
                },
                {
                  type: "tool_call",
                  id: "read-sibling",
                  name: "read",
                  input: { file_path: join(dirname(fullOutputPath), "unregistered.txt") },
                },
                { type: "tool_call", id: "read-outside", name: "read", input: { file_path: "/etc/passwd" } },
              ],
              "tool_use",
            ),
          ])(model, context, options);
        }
        return sequenceStream([assistantMessage([{ type: "text", text: "Recovered." }])])(model, context, options);
      },
    });

    expect(result.failures).toEqual([]);
    expect(fullOutputPath).not.toBe("");
    expect(existsSync(fullOutputPath)).toBe(false);
    const serialized = JSON.stringify(result.execution);
    expect(result.execution.toolOutputFiles).toEqual([
      {
        path: "$TOOL_OUTPUT/full-output-000001.txt",
        bytes: Buffer.byteLength(largeOutput),
        sha256: createHash("sha256").update(largeOutput).digest("hex"),
      },
    ]);
    expect(result.execution.toolCalls.find((trace) => trace.toolCallId === "read-exact")?.output).toEqual(
      expect.objectContaining({
        output: expect.stringContaining(hidden),
        render: expect.objectContaining({
          inputSummary: "$TOOL_OUTPUT/full-output-000001.txt",
          blocks: [
            expect.objectContaining({
              type: "file",
              filePath: "$TOOL_OUTPUT/full-output-000001.txt",
              content: "[registered tool output content omitted]",
              offset: 501,
              limit: 1,
            }),
          ],
        }),
      }),
    );
    expect(result.execution.toolCalls.find((trace) => trace.toolCallId === "read-project")?.output).toEqual(
      expect.objectContaining({
        render: expect.objectContaining({
          blocks: [expect.objectContaining({ type: "file", content: `${projectRenderContent}\n` })],
        }),
      }),
    );
    expect(
      result.execution.toolCalls
        .filter((trace) => trace.toolCallId === "read-sibling" || trace.toolCallId === "read-outside")
        .map((trace) => trace.outcome),
    ).toEqual(["policy_rejection", "policy_rejection"]);
    expect(serialized).toContain("$TOOL_OUTPUT/full-output-000001.txt");
    expect(serialized).toContain("[registered tool output content omitted]");
    expect(serialized).toContain(hidden);
    expect(serialized).toContain(projectRenderContent);
    expect(serialized).not.toContain(renderOnlySentinel);
    expect(JSON.stringify(result.execution.providerCalls)).toContain(hidden);
    expect(JSON.stringify(result.execution.providerCalls)).toContain("[registered tool output content omitted]");
    const registeredRenderSurfaces = {
      toolCalls: result.execution.toolCalls,
      providerCalls: result.execution.providerCalls,
      messages: result.execution.turns[0]!.messages,
      coreEvents: result.execution.turns[0]!.coreEvents,
      runtimeEvents: result.execution.turns[0]!.runtimeEvents,
      notifications: result.execution.turns[0]!.notifications,
      session: result.execution.session.lines,
      threadRead: result.execution.threadReads,
    };
    for (const [surface, evidence] of Object.entries(registeredRenderSurfaces)) {
      const serializedSurface = JSON.stringify(evidence);
      expect(serializedSurface, surface).toContain("[registered tool output content omitted]");
      expect(serializedSurface, surface).not.toContain(renderOnlySentinel);
      expect(serializedSurface, surface).not.toContain(basename(dirname(fullOutputPath)).slice(0, 30));
    }
    expect(serialized).not.toContain(basename(dirname(fullOutputPath)).slice(0, 30));
    expect(serialized).not.toContain(dirname(fullOutputPath));
  });

  test("removes the eval-owned output root after a failing run", async () => {
    const failureImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const hidden = "FAILURE-SELECTED-LINE-FACT";
    const renderOnlySentinel = "FAILURE-REGISTERED-RENDER-CONTENT-MUST-BE-OMITTED";
    const largeOutput = Array.from({ length: 600 }, (_, index) => {
      if (index === 450) return renderOnlySentinel;
      if (index === 500) return hidden;
      return `failure-line-${String(index + 1).padStart(3, "0")}-${"x".repeat(24)}`;
    }).join("\n");
    const task = createFullOutputTask(largeOutput, failureImage);
    let fullOutputPath = "";
    let phase = 0;
    const result = await runRuntimeEvalExecution({
      task,
      seed: "full-output-failure",
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: (model, context, options) => {
        if (phase++ === 0)
          return sequenceStream([
            assistantMessage(
              [{ type: "tool_call", id: "large-output-failure", name: "large_fixture_output", input: {} }],
              "tool_use",
            ),
          ])(model, context, options);
        const savedResult = context.messages.findLast(
          (message) => message.role === "tool_result" && message.toolName === "large_fixture_output",
        ) as (Message & { metadata?: { fullOutputPath?: string } }) | undefined;
        if (!fullOutputPath) {
          fullOutputPath = savedResult?.metadata?.fullOutputPath ?? "";
          return sequenceStream([
            assistantMessage(
              [
                {
                  type: "tool_call",
                  id: "read-exact-before-failure",
                  name: "read",
                  input: { file_path: fullOutputPath, offset: 501, limit: 1 },
                },
              ],
              "tool_use",
            ),
          ])(model, context, options);
        }
        throw new Error(`provider failed after ${fullOutputPath}`);
      },
    });

    const serialized = JSON.stringify(result.execution);
    expect(result.passed).toBe(false);
    expect(fullOutputPath).not.toBe("");
    expect(existsSync(fullOutputPath)).toBe(false);
    expect(serialized).not.toContain(basename(dirname(fullOutputPath)).slice(0, 30));
    expect(serialized).not.toContain(dirname(fullOutputPath));
    expect(serialized).toContain("$TOOL_OUTPUT/full-output-000001.txt");
    expect(serialized).toContain("[registered tool output content omitted]");
    expect(serialized).toContain("[base64 omitted]");
    expect(serialized).not.toContain(failureImage);
    expect(serialized).not.toContain(renderOnlySentinel);
    expect(result.execution.providerCalls.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(result.execution.providerCalls)).toContain(hidden);
    expect(JSON.stringify(result.execution.providerCalls)).toContain("[registered tool output content omitted]");
    expect(result.execution.toolCalls).toContainEqual(expect.objectContaining({ toolCallId: "large-output-failure" }));
    expect(result.execution.toolCalls).toContainEqual(
      expect.objectContaining({
        toolCallId: "read-exact-before-failure",
        output: expect.objectContaining({
          output: expect.stringContaining(hidden),
          render: expect.objectContaining({
            inputSummary: "$TOOL_OUTPUT/full-output-000001.txt",
            blocks: [
              expect.objectContaining({
                content: "[registered tool output content omitted]",
                offset: 501,
                limit: 1,
              }),
            ],
          }),
        }),
      }),
    );
    expect(result.execution.toolOutputFiles).toEqual([
      {
        path: "$TOOL_OUTPUT/full-output-000001.txt",
        bytes: Buffer.byteLength(largeOutput),
        sha256: createHash("sha256").update(largeOutput).digest("hex"),
      },
    ]);
    expect(result.execution.turns).toHaveLength(1);
    expect(result.execution.turns[0]?.termination).not.toBe("completed");
    expect(result.execution.turns[0]?.notifications.length).toBeGreaterThan(0);
    expect(result.execution.session.lines.length).toBeGreaterThan(1);
  });

  test("preserves and normalizes partial user-input request and session evidence after provider failure", async () => {
    let fixtureRoot = "";
    let phase = 0;
    let evaluatorCalls = 0;
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-partial-request-evidence",
      description: "retain partial requests",
      fixtureVersion: "partial-request-evidence-v0",
      limits: {
        ...DEFAULT_RUNTIME_LIMITS,
        maxTurns: 2,
        maxToolCalls: 1,
        maxUserInputRequests: 1,
        timeoutMs: 5_000,
      },
      toolPolicy: { allowedCapabilities: ["user_input"], allowedCommands: [] },
      async setup(seed, root) {
        fixtureRoot = root;
        return { root, seed, expected: "answer", protectedPaths: [], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "ask once" }],
      respondToServerRequest: (_world, request) =>
        ({ method: request.method, result: { answers: { path: "answer" } } }) as never,
      snapshotWorld: async () => ({}),
      evaluate: () => {
        evaluatorCalls += 1;
        return { passed: true };
      },
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "partial-seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: (model, context, options) => {
        if (phase++ === 0)
          return sequenceStream([
            assistantMessage(
              [
                {
                  type: "tool_call",
                  id: "partial-request",
                  name: "request_user_input",
                  input: {
                    questions: [
                      {
                        id: "path",
                        header: "Path",
                        question: `Confirm ${fixtureRoot}`,
                        options: [{ label: "Yes", description: `Use ${fixtureRoot}` }],
                      },
                    ],
                  },
                },
              ],
              "tool_use",
            ),
          ])(model, context, options);
        throw new Error(`provider failed under ${fixtureRoot}`);
      },
    });

    const serialized = JSON.stringify(result.execution);
    expect(result.passed).toBe(false);
    expect(result.failure).toMatchObject({
      dimension: "harness_terminal",
      category: "provider_terminal",
      code: "provider_terminal.unknown",
    });
    expect(evaluatorCalls).toBe(0);
    expect(result.execution.userInputRequests).toHaveLength(1);
    expect(serialized).toContain("$WORKSPACE");
    expect(serialized).not.toContain(fixtureRoot);
    expect(result.execution.turns[0]?.notifications.length).toBeGreaterThan(0);
    expect(result.execution.turns[0]?.termination).not.toBe("completed");
    expect(result.execution.session.lines.length).toBeGreaterThan(1);
  });
});

function cwdFromContext(context: StreamContext): string {
  const base = context.systemPrompt.find((section) => section.label === "base")?.content ?? "";
  const match = base.match(/^Current working directory: (.+)$/m);
  if (!match?.[1]) throw new Error("Missing runtime cwd in provider context.");
  return match[1];
}

function createFullOutputTask(output: string, imageData?: string): RuntimeEvalTask<RuntimeFixtureWorld> {
  return {
    id: "runtime-eval-owned-full-output",
    description: "exercise exact eval-owned full output reads",
    fixtureVersion: "eval-owned-full-output-v0",
    limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 3, maxToolCalls: 5, timeoutMs: 5_000 },
    statePolicy: {
      allowedMutations: ["infrastructure", "sessions", ...(imageData ? (["image_sidecars"] as const) : [])],
    },
    toolPolicy: {
      allowedTools: ["large_fixture_output", "read"],
      allowedCapabilities: ["read", "execute"],
      allowedCommands: [],
    },
    async setup(seed, root) {
      await writeFixture(root, { "project-render.txt": "PROJECT-RENDER-CONTENT-MUST-REMAIN\n" });
      return { root, seed, expected: "full output", protectedPaths: [], allowedChanges: [] };
    },
    createRuntimeConfig: createFixtureRuntimeConfig,
    createBundledToolProviders: () => [
      {
        id: "large-output-fixture",
        createTools: () => [
          {
            name: "large_fixture_output",
            description: "Return a deliberately truncation-sized fixture output",
            parameters: z.object({}),
            execute: async () => ({
              output,
              maxOutputBytes: 256,
              truncateDirection: "head" as const,
              ...(imageData && {
                outputImages: [
                  {
                    type: "image" as const,
                    source: { type: "base64" as const, media_type: "image/png", data: imageData },
                  },
                ],
              }),
            }),
          },
        ],
      },
    ],
    createSteps: () => [{ kind: "turn", message: "Recover the full fixture output." }],
    snapshotWorld: async () => ({}),
    evaluate: () => ({ passed: true }),
  };
}

function imagePairStream(expected: string): StreamFunction {
  return (model, context, options) => {
    const prompt = messageText([...context.messages].reverse().find((message) => message.role === "user"));
    const paths = [...prompt.matchAll(/\S+\/[ab]\.png/g)].map((match) => match[0]!);
    const results = context.messages.filter((message) => message.role === "tool_result") as Array<
      Message & { role: "tool_result"; toolName: string }
    >;
    const response =
      results.length === 0
        ? assistantMessage(
            [{ type: "tool_call", id: "image-a", name: "read_image", input: { file_path: paths[0] } }],
            "tool_use",
          )
        : results.length === 1
          ? assistantMessage(
              [{ type: "tool_call", id: "image-b", name: "read_image", input: { file_path: paths[1] } }],
              "tool_use",
            )
          : assistantMessage([{ type: "text", text: expected }]);
    return sequenceStream([response])(model, context, options);
  };
}

function messageText(message: Message | undefined): string {
  if (!message || message.role === "tool_result") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}
