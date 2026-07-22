// @summary Contract, evaluator, and fake-stream integration tests for the steer-during-fix runtime eval

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamContext, StreamFunction } from "@diligent/core/provider-contract";
import { runRuntimeEvalExecution } from "../../../src/runner/runtime-execution";
import { removeTemporaryRoot } from "../../../src/runner/runtime-workspace";
import type { RuntimeEvalExecution, RuntimeProtocolActionTrace } from "../../../src/runtime-task";
import { sha256Text, writeFixture } from "../../../src/tasks/runtime/helpers";
import { type SteerDuringFixWorld, steerDuringFixTask } from "../../../src/tasks/runtime/steer-during-fix";
import { assistantMessage, sequenceStream } from "../../helpers/fake-stream";

describe("steer-during-fix runtime eval", () => {
  test("defines a deterministic bounded fixture, natural prompt, action, and isolated policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-steer-during-fix-"));
    try {
      const world = await steerDuringFixTask.setup("shared-seed-123", root);
      const worldAgain = await steerDuringFixTask.setup("shared-seed-123", root);
      const steps = steerDuringFixTask.createSteps(world);
      const step = steps[0];

      expect(worldAgain).toEqual(world);
      expect(await readFile(join(root, world.targetPath), "utf8")).toBe(world.initialContent);
      expect(world.baseValue).not.toBe(world.originalRequestedValue);
      expect(world.originalRequestedValue).not.toBe(world.replacementValue);
      expect(world.protectedPaths).toEqual(["control.txt"]);
      expect(world.allowedChanges).toEqual([world.targetPath]);
      expect(steerDuringFixTask.toolPolicy).toEqual({
        allowedTools: ["read", "apply_patch", "edit"],
        allowedCapabilities: ["read", "write"],
        allowedCommands: [],
      });
      expect(steerDuringFixTask.statePolicy).toEqual({ allowedMutations: ["infrastructure", "sessions"] });
      expect(steerDuringFixTask.fixtureVersion).toBe("steer-during-fix-v5");
      expect(steerDuringFixTask.limits).toMatchObject({
        maxTurns: 5,
        maxToolCalls: 4,
        maxChangedFiles: 1,
        maxUserInputRequests: 0,
        maxChildAgents: 0,
      });
      expect(steps).toHaveLength(1);
      expect(step?.kind).toBe("turn");
      if (step?.kind !== "turn") throw new Error("Expected one turn step.");
      expect(step.message).toContain(world.targetPath);
      expect(step.message).toContain(world.originalRequestedValue);
      expect(step.message).not.toContain(world.replacementValue);
      expect(step.message.toLowerCase()).not.toContain("steer");
      expect(step.message.toLowerCase()).not.toContain("protocol");
      expect(step.message.toLowerCase()).not.toContain("tool");
      expect(step.actions).toEqual([
        {
          id: world.actionId,
          timeoutMs: 30_000,
          trigger: {
            source: "runtime_event",
            eventType: "tool_end",
            toolName: "read",
            isError: false,
            occurrence: 1,
            allowSubsequentMatches: true,
          },
          request: {
            method: "turn/steer",
            params: { content: world.steeringContent, steerId: world.steerId },
          },
        },
      ]);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("independent verifier accepts only exact replacement bytes and observes abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-steer-verifier-"));
    try {
      const world = await steerDuringFixTask.setup("shared-seed-123", root);
      await writeFixture(root, { [world.targetPath]: world.expected });
      expect(await steerDuringFixTask.verify!(world, new AbortController().signal)).toMatchObject({
        exitCode: 0,
        timedOut: false,
      });
      await writeFixture(root, { [world.targetPath]: `${world.originalRequestedValue}\n` });
      expect((await steerDuringFixTask.verify!(world, new AbortController().signal)).exitCode).toBe(1);
      const aborted = new AbortController();
      aborted.abort();
      expect(await steerDuringFixTask.verify!(world, aborted.signal)).toMatchObject({ exitCode: 1, timedOut: true });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("accepts strict write evidence from every supported eval provider", () => {
    const openai = validExecution();
    expect(steerDuringFixTask.evaluate(openai)).toEqual({ passed: true });

    const gemini = validExecution();
    gemini.profile.provider = "gemini";
    expect(steerDuringFixTask.evaluate(gemini)).toEqual({ passed: true });

    const anthropic = validExecution();
    anthropic.profile.provider = "anthropic";
    anthropic.toolCalls[1]!.name = "edit";
    anthropic.toolCalls[1]!.input = {
      file_path: `$WORKSPACE/${anthropic.world.targetPath}`,
      old_string: anthropic.world.initialContent,
      new_string: anthropic.world.expected,
      replace_all: false,
    };
    const writeEvent = (anthropic.turns[0]!.notifications[2]!.params as { event: { toolName: string } }).event;
    writeEvent.toolName = "edit";
    (anthropic.session.lines[4] as { message: { toolName: string } }).message.toolName = "edit";
    expect(steerDuringFixTask.evaluate(anthropic)).toEqual({ passed: true });
  });

  test("accepts an equivalent OpenAI patch that removes a rendered blank line", () => {
    const openai = validExecution();
    openai.toolCalls[1]!.input = {
      patch:
        `*** Begin Patch\n*** Update File: ${openai.world.targetPath}\n@@\n` +
        `-${openai.world.baseValue}\n-\n+${openai.world.replacementValue}\n*** End Patch`,
    };

    expect(steerDuringFixTask.evaluate(openai)).toEqual({ passed: true });
  });

  test("accepts an exact Anthropic line edit that preserves the existing trailing newline", () => {
    const anthropic = validExecution();
    anthropic.profile.provider = "anthropic";
    anthropic.toolCalls[1]!.name = "edit";
    anthropic.toolCalls[1]!.input = {
      file_path: `$WORKSPACE/${anthropic.world.targetPath}`,
      old_string: anthropic.world.baseValue,
      new_string: anthropic.world.replacementValue,
      replace_all: false,
    };
    const writeEvent = (anthropic.turns[0]!.notifications[2]!.params as { event: { toolName: string } }).event;
    writeEvent.toolName = "edit";
    (anthropic.session.lines[4] as { message: { toolName: string } }).message.toolName = "edit";

    expect(steerDuringFixTask.evaluate(anthropic)).toEqual({ passed: true });
  });

  test("accepts only one exact Anthropic relative-read recovery before the successful absolute read", () => {
    const recovered = anthropicRecoveryExecution();
    expect(steerDuringFixTask.evaluate(recovered)).toEqual({ passed: true });

    const cases: Array<[string, (execution: RuntimeEvalExecution<SteerDuringFixWorld>) => void]> = [
      ["wrong provider", (execution) => (execution.profile.provider = "openai")],
      [
        "absolute failed read",
        (execution) => (execution.toolCalls[0]!.input = { file_path: `$WORKSPACE/${execution.world.targetPath}` }),
      ],
      ["non-error recovery", (execution) => (execution.toolCalls[0]!.outcome = "success")],
      ["wrong recovery error", (execution) => (execution.toolCalls[0]!.error = "different error")],
      [
        "missing recovery error metadata",
        (execution) => delete (execution.toolCalls[0]!.output as { metadata?: unknown }).metadata,
      ],
      [
        "false recovery error metadata",
        (execution) =>
          (((execution.toolCalls[0]!.output as { metadata: { error: boolean } }).metadata.error as boolean) = false),
      ],
      ["non-adjacent recovery", (execution) => (execution.toolCalls[1]!.sequence = 3)],
      [
        "relative successful read",
        (execution) => (execution.toolCalls[1]!.input = { file_path: execution.world.targetPath }),
      ],
      ["missing parent attribution", (execution) => delete execution.toolCalls[0]!.threadId],
      ["wrong parent attribution", (execution) => (execution.toolCalls[2]!.threadId = "other-thread")],
      ["child attribution", (execution) => (execution.toolCalls[1]!.childThreadId = "child-thread")],
      [
        "extra recovery",
        (execution) =>
          execution.toolCalls.splice(1, 0, {
            ...structuredClone(execution.toolCalls[0]!),
            sequence: 2,
            toolCallId: "extra-recovery",
          }),
      ],
    ];

    for (const [name, mutate] of cases) {
      const execution = anthropicRecoveryExecution();
      mutate(execution);
      expect(steerDuringFixTask.evaluate(execution).passed, name).toBe(false);
    }
  });

  test("accepts one missing root instruction-file probe before the successful target read", () => {
    const execution = validExecution();
    const probe = structuredClone(execution.toolCalls[0]!);
    probe.toolCallId = "missing-root-instructions";
    probe.input = { file_path: "$WORKSPACE/AGENTS.md" };
    probe.outcome = "runtime_error";
    probe.error = "Error: File not found: $WORKSPACE/AGENTS.md";
    probe.output = { output: probe.error, metadata: { error: true } };
    execution.toolCalls.unshift(probe);
    execution.toolCalls.forEach((call, index) => (call.sequence = index + 1));

    expect(steerDuringFixTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("accepts one exact post-write confirmation read, including after Anthropic read recovery", () => {
    expect(steerDuringFixTask.evaluate(confirmationExecution(validExecution()))).toEqual({ passed: true });
    expect(steerDuringFixTask.evaluate(confirmationExecution(anthropicRecoveryExecution()))).toEqual({ passed: true });

    const cases: Array<[string, (execution: RuntimeEvalExecution<SteerDuringFixWorld>) => void]> = [
      [
        "wrong confirmation path",
        (execution) => (execution.toolCalls.at(-1)!.input = { file_path: "$WORKSPACE/other" }),
      ],
      ["wrong confirmation output", (execution) => (execution.toolCalls.at(-1)!.output = "wrong")],
      ["failed confirmation", (execution) => (execution.toolCalls.at(-1)!.outcome = "runtime_error")],
      ["confirmation before write", (execution) => (execution.toolCalls.at(-1)!.sequence = 2)],
      ["missing confirmation actor", (execution) => delete execution.toolCalls.at(-1)!.threadId],
      ["child confirmation", (execution) => (execution.toolCalls.at(-1)!.childThreadId = "child")],
      [
        "extra confirmation",
        (execution) =>
          execution.toolCalls.push({
            ...structuredClone(execution.toolCalls.at(-1)!),
            sequence: execution.toolCalls.at(-1)!.sequence + 1,
            toolCallId: "extra-confirmation",
          }),
      ],
    ];
    for (const [name, mutate] of cases) {
      const execution = confirmationExecution(validExecution());
      mutate(execution);
      expect(steerDuringFixTask.evaluate(execution).passed, name).toBe(false);
    }
  });

  test("ignores runner-owned action, notification, persistence, and provider mirror variation", () => {
    const cases: Array<[string, (execution: RuntimeEvalExecution<SteerDuringFixWorld>) => void]> = [
      ["missing action", (execution) => (execution.protocolActions = [])],
      ["missing notification", (execution) => execution.turns[0]!.notifications.splice(1, 1)],
      ["missing outer persistence", (execution) => execution.session.lines.splice(1, 1)],
      ["missing steering persistence", (execution) => execution.session.lines.splice(3, 1)],
      ["provider context variation", (execution) => (execution.providerCalls[1]!.messages.items = [])],
    ];
    for (const [name, mutate] of cases) {
      const execution = validExecution();
      mutate(execution);
      expect(steerDuringFixTask.evaluate(execution), name).toEqual({ passed: true });
    }
  });

  test("rejects malformed live trace, verifier, and final-state evidence with explicit dimensions", () => {
    const cases: Array<[string, (execution: RuntimeEvalExecution<SteerDuringFixWorld>) => void]> = [
      ["wrong read target", (execution) => (execution.toolCalls[0]!.input = { file_path: "$WORKSPACE/other.txt" })],
      ["wrong trace order", (execution) => (execution.toolCalls[0]!.sequence = 3)],
      ["duplicate trace sequence", (execution) => (execution.toolCalls[1]!.sequence = 1)],
      ["failed read", (execution) => (execution.toolCalls[0]!.outcome = "runtime_error")],
      ["failed write", (execution) => (execution.toolCalls[1]!.outcome = "runtime_error")],
      [
        "extra patch target",
        (execution) => {
          const input = execution.toolCalls[1]!.input as { patch: string };
          input.patch = input.patch.replace(
            "*** End Patch",
            "*** Update File: control.txt\n@@\n-control\n+changed\n*** End Patch",
          );
        },
      ],
      [
        "extra call",
        (execution) => execution.toolCalls.push({ ...execution.toolCalls[0]!, sequence: 3, toolCallId: "extra" }),
      ],
      ["verifier failure", (execution) => (execution.verifier!.exitCode = 1)],
      ["verifier timeout", (execution) => (execution.verifier!.timedOut = true)],
      ["wrong final hash", (execution) => (execution.workspace.final.entries[0]!.sha256 = "wrong")],
      ["wrong final size", (execution) => (execution.workspace.final.entries[0]!.size += 1)],
      [
        "original requested final value",
        (execution) =>
          (execution.workspace.final.entries[0]!.sha256 = sha256Text(`${execution.world.originalRequestedValue}\n`)),
      ],
    ];

    for (const [name, mutate] of cases) {
      const execution = validExecution();
      mutate(execution);
      const result = steerDuringFixTask.evaluate(execution);
      expect(result.passed, name).toBe(false);
      if (!result.passed) expect(result.dimension, name).toBeDefined();
    }
  });

  test("runs a real read, runner steer, provider-native mutation, and final response", async () => {
    const seed = "shared-seed-123";
    let providerCall = 0;
    let sawSteeringBeforeMutation = false;
    let scripted: StreamFunction | undefined;
    const result = await runRuntimeEvalExecution({
      task: steerDuringFixTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: (model, context, options) => {
        providerCall += 1;
        const world = resultWorld(seed);
        const target = join(cwdFromContext(context), world.targetPath);
        if (providerCall === 2) {
          const serialized = JSON.stringify(context.messages);
          sawSteeringBeforeMutation = serialized.includes(world.steeringContent) && serialized.includes("steer-read-1");
        }
        scripted ??= sequenceStream([
          assistantMessage(
            [{ type: "tool_call", id: "steer-read-1", name: "read", input: { file_path: target } }],
            "tool_use",
          ),
          assistantMessage(
            [
              {
                type: "tool_call",
                id: "steer-write-1",
                name: "apply_patch",
                input: { patch: expectedPatch(world) },
              },
            ],
            "tool_use",
          ),
          assistantMessage(
            [{ type: "tool_call", id: "steer-confirm-1", name: "read", input: { file_path: target } }],
            "tool_use",
          ),
          assistantMessage([{ type: "text", text: "Done." }]),
        ]);
        return scripted(model, context, options);
      },
    });
    const executionWorld = result.execution.world as SteerDuringFixWorld;

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(sawSteeringBeforeMutation).toBe(true);
    expect(result.execution.protocolActions).toHaveLength(1);
    expect(result.execution.protocolActions[0]).toMatchObject({
      status: "completed",
      triggerCount: 2,
      response: { queued: true, steerId: executionWorld.steerId },
    });
    expect(
      result.execution.turns[0]?.notifications.filter(
        (item) =>
          item.method === "agent/event" &&
          (item.params as { event?: { type?: string } }).event?.type === "steering_injected",
      ),
    ).toHaveLength(1);
    expect(
      result.execution.session.lines.filter((line) => JSON.stringify(line).includes(executionWorld.steeringContent)),
    ).toHaveLength(1);
    expect(
      result.execution.session.lines.filter((line) =>
        JSON.stringify(line).includes(result.execution.turns[0]!.clientPrompt),
      ),
    ).toHaveLength(1);
  });
});

function resultWorld(seed: string): SteerDuringFixWorld {
  const safeSeed = seed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "seed";
  const baseValue = `BASE_${safeSeed}`;
  const originalRequestedValue = `ORIGINAL_REQUEST_${safeSeed}`;
  const replacementValue = `REPLACEMENT_${safeSeed}`;
  const targetPath = "config/live-value.txt";
  const initialContent = `${baseValue}\n`;
  const expected = `${replacementValue}\n`;
  return {
    root: "$WORKSPACE",
    seed,
    targetPath,
    baseValue,
    originalRequestedValue,
    replacementValue,
    initialContent,
    expected,
    initialHash: sha256Text(initialContent),
    expectedHash: sha256Text(expected),
    actionId: "steer-during-fix-after-read",
    steerId: `steer-during-fix-${safeSeed}`,
    steeringContent: `Change the requirement for ${targetPath}: it must contain exactly ${replacementValue} and one trailing newline. Do not use ${originalRequestedValue}.`,
    protectedPaths: ["control.txt"],
    allowedChanges: [targetPath],
  };
}

function validExecution(): RuntimeEvalExecution<SteerDuringFixWorld> {
  const world = resultWorld("seed");
  const threadId = "thread-1";
  const prompt = `Inspect ${world.targetPath} to confirm its current value, then change that file so it contains exactly ${world.originalRequestedValue} and one trailing newline.`;
  const readTrace = {
    sequence: 1,
    toolCallId: "read-1",
    name: "read",
    capability: "read" as const,
    input: { file_path: `$WORKSPACE/${world.targetPath}` },
    outcome: "success" as const,
    output: world.initialContent,
    threadId,
  };
  const writeTrace = {
    sequence: 2,
    toolCallId: "write-1",
    name: "apply_patch",
    capability: "write" as const,
    input: { patch: expectedPatch(world) },
    outcome: "success" as const,
    threadId,
  };
  const action: RuntimeProtocolActionTrace = {
    id: world.actionId,
    turnIndex: 0,
    status: "completed",
    timeoutMs: 30_000,
    trigger: {
      source: "runtime_event",
      eventType: "tool_end",
      toolName: "read",
      isError: false,
      occurrence: 1,
      allowSubsequentMatches: true,
    },
    triggerCount: 1,
    triggeredAtMs: 4,
    triggerEvidence: { type: "tool_end", toolCallId: readTrace.toolCallId, toolName: "read", isError: false },
    request: { method: "turn/steer", params: { threadId, content: world.steeringContent, steerId: world.steerId } },
    requestedAtMs: 5,
    response: { queued: true, steerId: world.steerId },
    respondedAtMs: 6,
  };
  const readNotification = agentEvent(action.triggerEvidence);
  const steeringNotification = {
    method: "agent/event",
    params: {
      threadId,
      event: {
        type: "steering_injected",
        messageCount: 1,
        messages: [{ role: "user", content: world.steeringContent, timestamp: 1 }],
        steerIds: [world.steerId],
      },
    },
  };
  const writeNotification = agentEvent({
    type: "tool_start",
    toolCallId: writeTrace.toolCallId,
    toolName: "apply_patch",
  });
  return {
    taskId: steerDuringFixTask.id,
    profile: { provider: "openai", model: "test-model", effort: "medium" },
    seed: world.seed,
    startedAt: new Date(0).toISOString(),
    elapsedMs: 10,
    termination: "completed",
    turns: [
      {
        index: 0,
        threadId,
        clientPrompt: prompt,
        startedAt: new Date(0).toISOString(),
        elapsedMs: 10,
        termination: "completed",
        coreEvents: [],
        runtimeEvents: [],
        notifications: [readNotification, steeringNotification, writeNotification] as never,
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ],
    compactions: [],
    threadCwd: "$WORKSPACE",
    advertisedTools: [],
    threadReads: [],
    protocolActions: [action],
    providerCalls: [
      providerCall(1, [prompt]),
      providerCall(2, [readTrace.toolCallId, world.initialContent, world.steeringContent]),
    ],
    toolCalls: [readTrace, writeTrace],
    toolOutputFiles: [],
    approvals: [],
    userInputRequests: [],
    logs: [],
    session: {
      threadId,
      lines: [
        { type: "session", id: threadId },
        { type: "message", message: { role: "user", content: prompt } },
        { type: "message", message: { role: "tool_result", toolCallId: readTrace.toolCallId, toolName: "read" } },
        { type: "message", message: { role: "user", content: world.steeringContent } },
        {
          type: "message",
          message: { role: "tool_result", toolCallId: writeTrace.toolCallId, toolName: "apply_patch" },
        },
      ],
    },
    childSessions: [],
    workspace: {
      initial: {
        entries: [
          { path: world.targetPath, kind: "file", size: world.initialContent.length, sha256: world.initialHash },
        ],
      },
      final: {
        entries: [{ path: world.targetPath, kind: "file", size: world.expected.length, sha256: world.expectedHash }],
      },
    },
    runtimeState: { initial: [], final: [], diff: [] },
    verifier: {
      argv: ["steer-during-fix-verifier"],
      exitCode: 0,
      elapsedMs: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
    },
    world,
  };
}

function anthropicRecoveryExecution(): RuntimeEvalExecution<SteerDuringFixWorld> {
  const execution = validExecution();
  const [read, write] = execution.toolCalls;
  if (!read || !write) throw new Error("Expected baseline read and write traces.");
  execution.profile.provider = "anthropic";
  const recoveryError = `Error: file_path must be absolute: ${execution.world.targetPath}`;
  const recovery = {
    sequence: 1,
    toolCallId: "read-relative",
    name: "read",
    capability: "read" as const,
    input: { file_path: execution.world.targetPath },
    outcome: "runtime_error" as const,
    output: { output: recoveryError, metadata: { error: true } },
    error: recoveryError,
    threadId: execution.turns[0]!.threadId,
  };
  read.sequence = 2;
  write.sequence = 3;
  write.name = "edit";
  write.input = {
    file_path: `$WORKSPACE/${execution.world.targetPath}`,
    old_string: execution.world.baseValue,
    new_string: execution.world.replacementValue,
    replace_all: false,
  };
  execution.toolCalls.unshift(recovery);
  execution.turns[0]!.notifications.unshift(
    agentEvent({ type: "tool_end", toolCallId: recovery.toolCallId, toolName: "read", isError: true }) as never,
  );
  const writeEvent = (execution.turns[0]!.notifications.at(-1)!.params as { event: { toolName: string } }).event;
  writeEvent.toolName = "edit";
  execution.providerCalls = [
    providerCall(1, [execution.turns[0]!.clientPrompt]),
    providerCall(2, [recovery.toolCallId, recoveryError]),
    providerCall(3, [read.toolCallId, execution.world.initialContent, execution.world.steeringContent]),
  ];
  execution.session.lines.splice(2, 0, {
    type: "message",
    message: { role: "tool_result", toolCallId: recovery.toolCallId, toolName: "read", isError: true },
  });
  (execution.session.lines[5] as { message: { toolName: string } }).message.toolName = "edit";
  return execution;
}

function confirmationExecution(
  execution: RuntimeEvalExecution<SteerDuringFixWorld>,
): RuntimeEvalExecution<SteerDuringFixWorld> {
  const confirmation = {
    sequence: Math.max(...execution.toolCalls.map((trace) => trace.sequence)) + 1,
    toolCallId: "read-confirmation",
    name: "read",
    capability: "read" as const,
    input: { file_path: `$WORKSPACE/${execution.world.targetPath}` },
    outcome: "success" as const,
    output: execution.world.expected,
    threadId: execution.turns[0]!.threadId,
  };
  execution.toolCalls.push(confirmation);
  execution.protocolActions[0]!.triggerCount = 2;
  execution.turns[0]!.notifications.push(
    agentEvent({
      type: "tool_end",
      toolCallId: confirmation.toolCallId,
      toolName: confirmation.name,
      isError: false,
    }) as never,
  );
  execution.session.lines.push({
    type: "message",
    message: { role: "tool_result", toolCallId: confirmation.toolCallId, toolName: confirmation.name },
  });
  execution.providerCalls.push(
    providerCall(execution.providerCalls.length + 1, [
      execution.toolCalls.at(-2)!.toolCallId,
      confirmation.toolCallId,
      execution.world.expected,
    ]),
  );
  return execution;
}

function expectedPatch(world: SteerDuringFixWorld): string {
  return `*** Begin Patch\n*** Update File: ${world.targetPath}\n@@\n-${world.baseValue}\n+${world.replacementValue}\n*** End Patch`;
}

function agentEvent(event: unknown) {
  return { method: "agent/event", params: { threadId: "thread-1", event } };
}

function providerCall(sequence: number, items: unknown[]) {
  return {
    sequence,
    model: { provider: "openai", modelId: "test-model" },
    systemPrompt: { totalCount: 0, includedCount: 0, omittedCount: 0, items: [] },
    messages: { totalCount: items.length, includedCount: items.length, omittedCount: 0, items },
    tools: { totalCount: 0, includedCount: 0, omittedCount: 0, items: [] },
    streamOptions: {},
    bounds: {
      maxSourceItems: 10,
      maxNestedItems: 10,
      maxObjectProperties: 10,
      maxStringChars: 10_000,
      maxDepth: 10,
      truncatedStrings: 0,
      omittedNestedItems: 0,
      omittedObjectProperties: 0,
    },
  } as RuntimeEvalExecution<unknown>["providerCalls"][number];
}

function cwdFromContext(context: StreamContext): string {
  const base = context.systemPrompt.find((section) => section.label === "base")?.content ?? "";
  const match = base.match(/^Current working directory: (.+)$/m);
  if (!match?.[1]) throw new Error("Missing runtime cwd in provider context.");
  return match[1];
}
