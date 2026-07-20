// @summary Contract, strict mutation matrix, and assembled-runtime coverage for loop-context-adaptation

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@diligent/core/message-contract";
import type { StreamContext, StreamFunction } from "@diligent/core/provider-contract";
import { DEFAULT_PROFILES } from "../../../src/profiles";
import { runRuntimeEvalExecution } from "../../../src/runner/runtime-execution";
import { removeTemporaryRoot } from "../../../src/runner/runtime-workspace";
import type { RuntimeEvalExecution } from "../../../src/runtime-task";
import type { EvalProfile } from "../../../src/task";
import { writeFixture } from "../../../src/tasks/runtime/helpers";
import {
  type LoopContextAdaptationWorld,
  loopContextAdaptationTask,
} from "../../../src/tasks/runtime/loop-context-adaptation";
import { assistantMessage, sequenceStream } from "../../helpers/fake-stream";

describe("loop-context-adaptation", () => {
  test("defines a deterministic isolated fixture and opaque natural prompt", async () => {
    expect(loopContextAdaptationTask.fixtureVersion).toBe("loop-context-adaptation-v7");
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-loop-context-"));
    try {
      const world = await loopContextAdaptationTask.setup("shared-seed-123", root);
      const again = await loopContextAdaptationTask.setup("shared-seed-123", root);
      expect(again).toEqual(world);
      expect(world.initialValue).not.toBe(world.injectedValue);
      expect(world.initialBrief).toContain(world.initialValue);
      expect(world.initialBrief).not.toContain(world.injectedValue);
      expect(world.injectedContext).toContain(world.injectedValue);
      expect(world.clientPrompt).not.toContain(world.initialValue);
      expect(world.clientPrompt).not.toContain(world.injectedValue);
      expect(world.clientPrompt).toContain("deployment-brief.txt");
      expect(world.clientPrompt).toContain("RESULT.txt does not exist yet");
      expect(world.clientPrompt).toContain("No other project file is relevant");
      expect(world.clientPrompt.toLowerCase()).not.toMatch(/hook|inject|boundary|sequence|read|apply_patch|edit/);
      expect(loopContextAdaptationTask.createSteps(world)).toEqual([
        { kind: "turn", mode: "default", message: world.clientPrompt },
      ]);
      expect(world.protectedPaths).toEqual(["deployment-brief.txt", ".git/.keep"]);
      expect(world.allowedChanges).toEqual(["RESULT.txt"]);
      expect(loopContextAdaptationTask.toolPolicy).toEqual({
        allowedTools: ["read", "apply_patch", "edit"],
        allowedCapabilities: ["read", "write"],
        allowedCommands: [],
      });
      expect(loopContextAdaptationTask.limits).toMatchObject({
        maxTurns: 4,
        maxToolCalls: 3,
        maxChangedFiles: 1,
        maxUserInputRequests: 0,
        maxChildAgents: 0,
      });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("fixture-owned hook arms only on the intended successful read and injects exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-loop-hook-"));
    try {
      const world = await loopContextAdaptationTask.setup("shared-seed-123", root);
      const [provider] = await loopContextAdaptationTask.createBundledToolProviders!(world);
      const [hook] = provider!.createAgentLoopHooks!({
        cwd: root,
        agentKind: "main",
        model: {} as never,
        tools: [{ name: "read" }, { name: "apply_patch" }] as never,
        logger: {} as never,
      });
      expect(hook!.beforeTurn!({ messages: [], turnId: "turn-1", compactedThisTurn: false })).toBeUndefined();
      hook!.onToolResult!({
        turnId: "turn-1",
        toolCall: { type: "tool_call", id: "wrong", name: "read", input: { file_path: join(root, "other.txt") } },
        result: {
          role: "tool_result",
          toolCallId: "wrong",
          toolName: "read",
          output: world.initialBrief,
          isError: false,
          timestamp: 1,
        },
      });
      expect(hook!.beforeTurn!({ messages: [], turnId: "turn-2", compactedThisTurn: false })).toBeUndefined();
      hook!.onToolResult!({
        turnId: "turn-2",
        toolCall: {
          type: "tool_call",
          id: "failed",
          name: "read",
          input: { file_path: join(root, "deployment-brief.txt") },
        },
        result: {
          role: "tool_result",
          toolCallId: "failed",
          toolName: "read",
          output: world.initialBrief,
          isError: true,
          timestamp: 1,
        },
      });
      expect(hook!.beforeTurn!({ messages: [], turnId: "turn-3", compactedThisTurn: false })).toBeUndefined();
      hook!.onToolResult!({
        turnId: "turn-3",
        toolCall: {
          type: "tool_call",
          id: "brief-read",
          name: "read",
          input: { file_path: join(root, "deployment-brief.txt").replaceAll("/", "\\") },
        },
        result: {
          role: "tool_result",
          toolCallId: "brief-read",
          toolName: "read",
          output: world.initialBrief,
          isError: false,
          timestamp: 1,
        },
      });
      expect(hook!.beforeTurn!({ messages: [], turnId: "turn-4", compactedThisTurn: false })).toEqual([
        {
          source: "eval-loop-context-adaptation",
          content: world.injectedContext,
          metadata: {
            presentation: {
              kind: "requirement-update",
              title: "Requirement updated",
              content: "The active deployment lane changed after the project brief was inspected.",
            },
          },
        },
      ]);
      expect(hook!.beforeTurn!({ messages: [], turnId: "turn-5", compactedThisTurn: false })).toBeUndefined();
      expect(world.hookRecords.filter((record) => record.injected)).toHaveLength(1);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("independent verifier accepts only exact injected bytes and observes abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-loop-verifier-"));
    try {
      const world = await loopContextAdaptationTask.setup("shared-seed-123", root);
      await writeFixture(root, { "RESULT.txt": world.expected });
      expect(await loopContextAdaptationTask.verify!(world, new AbortController().signal)).toMatchObject({
        argv: ["eval-exact-files", "RESULT.txt"],
        exitCode: 0,
        timedOut: false,
      });
      await writeFixture(root, { "RESULT.txt": `${world.initialValue}\n` });
      expect((await loopContextAdaptationTask.verify!(world, new AbortController().signal)).exitCode).toBe(1);
      const aborted = new AbortController();
      aborted.abort();
      expect(await loopContextAdaptationTask.verify!(world, aborted.signal)).toMatchObject({
        exitCode: 1,
        timedOut: true,
      });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("accepts one bounded completion sentence that reports only the adapted seeded value", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!);
    const message = execution.turns[0]!.messages.at(-1)!;
    if (message.role !== "assistant") throw new Error("Missing final assistant.");
    message.content = [
      {
        type: "text",
        text: `Created RESULT.txt with the active lane ${execution.world.injectedValue}.`,
      },
    ];

    expect(loopContextAdaptationTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("runs the real AgentLoopHook injection path for both default provider shapes", async () => {
    for (const profile of DEFAULT_PROFILES) {
      const execution = await assembledExecution(profile);
      expect(loopContextAdaptationTask.evaluate(execution), profile.provider).toEqual({ passed: true });
      expect(execution.world.hookRecords.filter((record) => record.injected)).toHaveLength(1);
      expect(execution.providerCalls).toHaveLength(3);
      expect(JSON.stringify(execution.providerCalls[1]!.messages.items)).toContain(execution.world.injectedContext);
      expect(
        execution.turns[0]!.runtimeEvents.filter((event) => (event as { type?: string }).type === "context_notice"),
      ).toHaveLength(1);
      expect(
        execution.turns[0]!.runtimeEvents.some((event) => (event as { type?: string }).type === "context_injected"),
      ).toBe(false);
      expect(lastAssistantText(execution.turns[0]!.messages)).toBe(execution.world.injectedValue);
      expect(lastAssistantText(execution.turns[0]!.messages)).not.toContain(execution.world.initialValue);
    }
  });

  test("accepts one exact absent-file edit recovery and rejects an adjacent wrong replacement", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES.find((profile) => profile.provider === "anthropic")!, {
      recoverCreate: true,
    });
    expect(loopContextAdaptationTask.evaluate(execution)).toMatchObject({ passed: true });

    const changed = structuredClone(execution);
    const failed = changed.toolCalls.find((call) => call.outcome === "runtime_error")!;
    (failed.input as { new_string: string }).new_string = "wrong lane\n";
    expect(loopContextAdaptationTask.evaluate(changed).passed).toBe(false);
  });

  test("accepts one failed root-instructions probe before the exact adapted write", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!, { probeMissingRootInstructions: true });

    expect(execution.toolCalls.map((call) => [call.name, call.outcome])).toEqual([
      ["read", "success"],
      ["read", "runtime_error"],
      ["apply_patch", "success"],
    ]);
    expect(loopContextAdaptationTask.evaluate(execution)).toMatchObject({ passed: true });

    const patch = (execution.toolCalls[2]!.input as { patch: string }).patch;
    (execution.toolCalls[2]!.input as { patch: string }).patch = `${patch}\n`;
    expect(loopContextAdaptationTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("accepts one exact post-write confirmation read and rejects another path", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!);
    const confirmation = structuredClone(execution.toolCalls[0]!);
    confirmation.sequence = 3;
    confirmation.toolCallId = "loop-confirm-result";
    confirmation.input = { file_path: "$WORKSPACE/RESULT.txt" };
    confirmation.output = { output: `1\t${execution.world.expected.trimEnd()}\n2\t` };
    execution.toolCalls.push(confirmation);

    expect(loopContextAdaptationTask.evaluate(execution)).toMatchObject({ passed: true });

    confirmation.input = { file_path: "$WORKSPACE/other.txt" };
    expect(loopContextAdaptationTask.evaluate(execution)).toMatchObject({
      passed: false,
      code: "loop_context_adaptation.tools",
    });
  });

  test("rejects omitted, malformed, duplicated, and reordered evidence across the strict matrix", async () => {
    const baseline = await assembledExecution(DEFAULT_PROFILES[0]!);
    expect(loopContextAdaptationTask.evaluate(baseline)).toEqual({ passed: true });
    const cases: Array<[string, (value: RuntimeEvalExecution<LoopContextAdaptationWorld>) => void]> = [
      ["termination", (value) => (value.termination = "runtime_error")],
      ["fixture seed", (value) => (value.world.seed = "wrong")],
      ["prompt injected leak", (value) => (value.turns[0]!.clientPrompt += value.world.injectedValue)],
      ["prompt named sequence", (value) => (value.turns[0]!.clientPrompt += " read hook")],
      ["duplicate turn", (value) => value.turns.push(structuredClone(value.turns[0]!))],
      ["thread mismatch", (value) => (value.turns[0]!.threadId = "other")],
      ["missing hook factory", (value) => value.world.factoryCalls.pop()],
      ["child hook factory", (value) => (value.world.factoryCalls[0]!.agentKind = "child")],
      ["missing hook record", (value) => value.world.hookRecords.splice(2, 1)],
      ["duplicate injection", (value) => (value.world.hookRecords[4]!.injected = true)],
      ["reordered hook", (value) => value.world.hookRecords.reverse()],
      ["failed trigger", (value) => (value.world.hookRecords[1]!.success = false)],
      ["wrong trigger tool", (value) => (value.world.hookRecords[1]!.toolName = "edit")],
      ["raw runtime injection", addRawRuntimeInjection],
      ["raw core injection", addRawCoreInjection],
      ["raw notification injection", addRawNotificationInjection],
      ["missing notice", removeNotice],
      ["missing core notice", removeCoreNotice],
      ["missing notification notice", removeNotificationNotice],
      ["duplicate notice", duplicateNotice],
      ["malformed notice", malformedNotice],
      ["reordered notice", reorderNoticeAfterWrite],
      ["divergent event surfaces", addRuntimeOnlyUnrelatedEvent],
      ["missing provider call", (value) => value.providerCalls.splice(1, 1)],
      ["duplicate provider call", (value) => value.providerCalls.push(structuredClone(value.providerCalls[2]!))],
      ["provider sequence", (value) => (value.providerCalls[1]!.sequence = 1)],
      ["provider model", (value) => (value.providerCalls[1]!.model.modelId = "wrong")],
      ["provider effort", (value) => (value.providerCalls[1]!.streamOptions.effort = "wrong")],
      ["provider message bounds", (value) => (value.providerCalls[1]!.messages.totalCount += 1)],
      ["provider tool surface", (value) => value.providerCalls[1]!.tools.items.pop()],
      ["provider evidence truncation", (value) => (value.providerCalls[1]!.bounds.truncatedStrings += 1)],
      ["early injection", (value) => value.providerCalls[0]!.messages.items.push(value.world.injectedContext)],
      ["missing injected context", removeInjectedProviderContext],
      ["misordered injected context", moveInjectedProviderContextFirst],
      ["tool trigger order", (value) => value.toolCalls.reverse()],
      ["trigger failure", (value) => (value.toolCalls[0]!.outcome = "runtime_error")],
      ["undeclared tool", (value) => (value.toolCalls[0]!.name = "shell")],
      [
        "inexact read path",
        (value) => (value.toolCalls[0]!.input = { file_path: "$WORKSPACE/other/deployment-brief.txt" }),
      ],
      ["wrong write value", replaceWriteWithInitial],
      ["extra write input", addWriteInputField],
      ["verifier", (value) => (value.verifier!.exitCode = 1)],
      ["final hash", mutateFinalHash],
      ["coupled initial/final file kind", mutateCoupledBriefKind],
      ["coupled initial/final file size", mutateCoupledBriefSize],
      ["result file kind", (value) => (resultEntry(value).kind = "symlink")],
      ["result file size", (value) => (resultEntry(value).size += 1)],
      ["undeclared workspace file", addUndeclaredWorkspaceFile],
      ["final pre-injection answer", replaceFinalAssistantWithInitial],
      ["final answer extra text", appendFinalAssistantText],
      ["missing internal entry", removeInternal],
      ["duplicate internal entry", duplicateInternal],
      ["internal source", mutateInternalSource],
      ["internal visibility", removeInternalVisibility],
      ["internal content", mutateInternalContent],
      ["internal presentation", mutateInternalPresentation],
      ["internal parent linkage", mutateInternalParent],
      ["reordered internal", reorderInternalAfterWrite],
      ["context item leak", leakContextItem],
      ["context item id", mutateContextItemId],
      ["context item source", mutateContextItemSource],
      ["context item presentation", mutateContextItemPresentation],
      ["protected brief", mutateProtectedBrief],
      ["protected git keep", mutateProtectedKeep],
      ["runtime state", (value) => value.runtimeState.diff.push({ path: "x", category: "knowledge", change: "added" })],
      ["child", (value) => value.childSessions.push({ threadId: "child", lines: [] })],
      ["compaction", (value) => value.compactions.push({} as never)],
      ["action", (value) => value.protocolActions.push({} as never)],
      ["approval", (value) => value.approvals.push({})],
      ["input", (value) => value.userInputRequests.push({})],
      ["network or output file", (value) => value.toolOutputFiles.push({ path: "network", bytes: 1, sha256: "x" })],
    ];
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      mutate(changed);
      const result = loopContextAdaptationTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
  });
});

async function assembledExecution(
  profile: EvalProfile,
  scenario: { recoverCreate?: boolean; probeMissingRootInstructions?: boolean } = {},
): Promise<RuntimeEvalExecution<LoopContextAdaptationWorld>> {
  const seed = "shared-seed-123";
  let call = 0;
  let stream: StreamFunction | undefined;
  const result = await runRuntimeEvalExecution({
    task: loopContextAdaptationTask,
    seed,
    profile,
    streamFunction(model, context, options) {
      call += 1;
      const initial = token(seed, "LANE_INITIAL");
      const updated = token(seed, "LANE_UPDATED");
      if (call === 1) {
        expect(JSON.stringify(context.messages)).not.toContain(initial);
        expect(JSON.stringify(context.messages)).not.toContain(updated);
      }
      if (call === 2) {
        expect(JSON.stringify(context.messages)).toContain(initial);
        expect(JSON.stringify(context.messages)).toContain(updated);
      }
      const cwd = cwdFromContext(context);
      const writeCalls = scenario.recoverCreate
        ? [
            assistantMessage(
              [
                {
                  type: "tool_call",
                  id: "loop-write-probe",
                  name: "edit",
                  input: {
                    file_path: join(cwd, "RESULT.txt"),
                    old_string: "placeholder",
                    new_string: `${updated}\n`,
                    replace_all: false,
                  },
                },
              ],
              "tool_use",
            ),
            assistantMessage(
              [
                {
                  type: "tool_call",
                  id: "loop-write-1",
                  name: "edit",
                  input: {
                    file_path: join(cwd, "RESULT.txt"),
                    old_string: "",
                    new_string: `${updated}\n`,
                    replace_all: false,
                  },
                },
              ],
              "tool_use",
            ),
          ]
        : [
            assistantMessage(
              [
                {
                  type: "tool_call",
                  id: "loop-write-1",
                  name: profile.provider === "anthropic" ? "edit" : "apply_patch",
                  input:
                    profile.provider === "anthropic"
                      ? {
                          file_path: join(cwd, "RESULT.txt"),
                          old_string: "",
                          new_string: `${updated}\n`,
                          replace_all: false,
                        }
                      : {
                          patch: `*** Begin Patch\n*** Add File: RESULT.txt\n+${updated}\n*** End Patch`,
                        },
                },
              ],
              "tool_use",
            ),
          ];
      stream ??= sequenceStream([
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "loop-read-1",
              name: "read",
              input: { file_path: join(cwd, "deployment-brief.txt") },
            },
          ],
          "tool_use",
        ),
        ...(scenario.probeMissingRootInstructions
          ? [
              assistantMessage(
                [
                  {
                    type: "tool_call",
                    id: "loop-read-instructions",
                    name: "read",
                    input: { file_path: join(cwd, "AGENTS.md") },
                  },
                ],
                "tool_use",
              ),
            ]
          : []),
        ...writeCalls,
        assistantMessage([{ type: "text", text: updated }]),
      ]);
      return stream(model, context, options);
    },
  });
  expect(result.failures, JSON.stringify(result.execution.toolCalls)).toEqual([]);
  return result.execution as RuntimeEvalExecution<LoopContextAdaptationWorld>;
}

function token(seed: string, prefix: string): string {
  return `${prefix}_${seed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10)}`;
}

function cwdFromContext(context: StreamContext): string {
  const base = context.systemPrompt.find((section) => section.label === "base")?.content ?? "";
  const match = base.match(/^Current working directory: (.+)$/m);
  if (!match?.[1]) throw new Error("Missing runtime cwd in provider context.");
  return match[1];
}

function lastAssistantText(messages: Message[]): string {
  const message = [...messages].reverse().find((item) => item.role === "assistant");
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function addRawRuntimeInjection(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  value.turns[0]!.runtimeEvents.push({ type: "context_injected" });
}
function addRawCoreInjection(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  value.turns[0]!.coreEvents.push({ sequence: 999, relativeMs: 0, event: { type: "context_injected" } as never });
}
function addRawNotificationInjection(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  value.turns[0]!.notifications.push({
    method: "agent/event",
    params: { event: { type: "context_injected" } },
  } as never);
}
function noticeIndex(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): number {
  return value.turns[0]!.runtimeEvents.findIndex((event) => (event as { type?: string }).type === "context_notice");
}
function removeNotice(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  value.turns[0]!.runtimeEvents.splice(noticeIndex(value), 1);
}
function removeCoreNotice(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  const index = value.turns[0]!.coreEvents.findIndex(
    (item) => (item.event as unknown as { type?: string }).type === "context_notice",
  );
  value.turns[0]!.coreEvents.splice(index, 1);
}
function removeNotificationNotice(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  const index = value.turns[0]!.notifications.findIndex(
    (notice) =>
      notice.method === "agent/event" &&
      (notice.params as unknown as { event?: { type?: string } }).event?.type === "context_notice",
  );
  value.turns[0]!.notifications.splice(index, 1);
}
function duplicateNotice(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  const index = noticeIndex(value);
  value.turns[0]!.runtimeEvents.splice(index, 0, structuredClone(value.turns[0]!.runtimeEvents[index]!));
}
function malformedNotice(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  (value.turns[0]!.runtimeEvents[noticeIndex(value)] as { presentation: { title: string } }).presentation.title = "";
}
function reorderNoticeAfterWrite(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  const events = value.turns[0]!.runtimeEvents;
  const [notice] = events.splice(noticeIndex(value), 1);
  const write = events.findIndex(
    (event) => (event as { toolCallId?: string }).toolCallId === value.toolCalls[1]!.toolCallId,
  );
  events.splice(write + 1, 0, notice!);
}
function addRuntimeOnlyUnrelatedEvent(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  value.turns[0]!.runtimeEvents.push({ type: "message_delta", delta: "forged" });
}
function removeInjectedProviderContext(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  value.providerCalls[1]!.messages.items = JSON.parse(
    JSON.stringify(value.providerCalls[1]!.messages.items).replaceAll(value.world.injectedContext, "removed"),
  );
}
function moveInjectedProviderContextFirst(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  const items = value.providerCalls[1]!.messages.items;
  const index = items.findIndex((item) => JSON.stringify(item).includes(value.world.injectedContext));
  items.unshift(...items.splice(index, 1));
}
function replaceWriteWithInitial(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  value.toolCalls[1]!.input = JSON.parse(
    JSON.stringify(value.toolCalls[1]!.input).replaceAll(value.world.injectedValue, value.world.initialValue),
  );
}
function addWriteInputField(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  (value.toolCalls[1]!.input as Record<string, unknown>).extra = true;
}
function mutateFinalHash(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  value.workspace.final.entries.find((entry) => entry.path === "RESULT.txt")!.sha256 = "wrong";
}
function mutateCoupledBriefKind(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  for (const snapshot of [value.workspace.initial, value.workspace.final]) {
    snapshot.entries.find((entry) => entry.path === "deployment-brief.txt")!.kind = "symlink";
  }
}
function mutateCoupledBriefSize(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  for (const snapshot of [value.workspace.initial, value.workspace.final]) {
    snapshot.entries.find((entry) => entry.path === "deployment-brief.txt")!.size += 1;
  }
}
function resultEntry(value: RuntimeEvalExecution<LoopContextAdaptationWorld>) {
  return value.workspace.final.entries.find((entry) => entry.path === "RESULT.txt")!;
}
function addUndeclaredWorkspaceFile(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  value.workspace.final.entries.push({ path: "extra.txt", kind: "file", size: 1, sha256: "wrong" });
}
function replaceFinalAssistantWithInitial(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  const message = value.turns[0]!.messages.at(-1)!;
  if (message.role !== "assistant") throw new Error("Missing final assistant.");
  message.content = [{ type: "text", text: value.world.initialValue }];
}
function appendFinalAssistantText(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  const message = value.turns[0]!.messages.at(-1)!;
  if (message.role !== "assistant") throw new Error("Missing final assistant.");
  message.content.push({ type: "text", text: " extra" });
}
function internalIndex(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): number {
  return value.session.lines.findIndex((line) => (line as { visibility?: string }).visibility === "internal");
}
function removeInternal(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  value.session.lines.splice(internalIndex(value), 1);
}
function duplicateInternal(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  const index = internalIndex(value);
  value.session.lines.splice(index, 0, structuredClone(value.session.lines[index]!));
}
function mutateInternalSource(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  (value.session.lines[internalIndex(value)] as { source: string }).source = "wrong";
}
function removeInternalVisibility(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  delete (value.session.lines[internalIndex(value)] as { visibility?: string }).visibility;
}
function mutateInternalContent(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  (value.session.lines[internalIndex(value)] as { message: { content: string } }).message.content = "wrong";
}
function mutateInternalPresentation(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  (value.session.lines[internalIndex(value)] as { presentation: { kind: string } }).presentation.kind = "wrong";
}
function mutateInternalParent(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  (value.session.lines[internalIndex(value)] as { parentId: string }).parentId = "wrong";
}
function reorderInternalAfterWrite(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  const index = internalIndex(value);
  value.session.lines.push(...value.session.lines.splice(index, 1));
}
function leakContextItem(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  const item = value.threadReads[0]!.response.items.find((entry) => entry.type === "contextMessage")!;
  (item as unknown as { content: string }).content = value.world.injectedContext;
}
function contextItem(value: RuntimeEvalExecution<LoopContextAdaptationWorld>) {
  return value.threadReads[0]!.response.items.find((entry) => entry.type === "contextMessage")!;
}
function mutateContextItemId(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  contextItem(value).itemId = "wrong";
}
function mutateContextItemSource(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  contextItem(value).source = "wrong";
}
function mutateContextItemPresentation(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  contextItem(value).presentation.title = "wrong";
}
function mutateProtectedBrief(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  value.workspace.final.entries.find((entry) => entry.path === "deployment-brief.txt")!.sha256 = "wrong";
}
function mutateProtectedKeep(value: RuntimeEvalExecution<LoopContextAdaptationWorld>): void {
  value.workspace.final.entries.find((entry) => entry.path === ".git/.keep")!.sha256 = "wrong";
}
