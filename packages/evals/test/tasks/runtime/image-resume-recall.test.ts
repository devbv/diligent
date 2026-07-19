// @summary Contract, strict evaluator mutations, and assembled restart coverage for image-resume-recall

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@diligent/core/message-contract";
import type { StreamContext, StreamFunction } from "@diligent/core/provider-contract";
import { runRuntimeEvalExecution } from "../../../src/runner/runtime-execution";
import { removeTemporaryRoot } from "../../../src/runner/runtime-workspace";
import type { RuntimeEvalExecution } from "../../../src/runtime-task";
import type { EvalProfile } from "../../../src/task";
import { solidColorPng } from "../../../src/tasks/image-fixture";
import { type ImageResumeRecallWorld, imageResumeRecallTask } from "../../../src/tasks/runtime/image-resume-recall";
import { assistantMessage, sequenceStream } from "../../helpers/fake-stream";

describe("image-resume-recall", () => {
  test("defines one protected deterministic image and an opaque turn/restart/turn contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-image-resume-"));
    try {
      const world = await imageResumeRecallTask.setup("shared-seed-123", root);
      const image = await readFile(join(root, world.fixturePath));
      const steps = imageResumeRecallTask.createSteps(world);

      expect(image.equals(solidColorPng(world.color))).toBe(true);
      expect(world.expected).toBe(`COLOR=${world.color}`);
      expect(world.protectedPaths).toEqual([world.fixturePath]);
      expect(world.allowedChanges).toEqual([]);
      expect(steps.map((step) => step.kind)).toEqual(["turn", "restart_and_resume", "turn"]);
      expect(JSON.stringify(steps)).not.toContain(world.color);
      expect(steps[0]?.kind === "turn" ? steps[0].message : "").toContain(world.fixturePath);
      expect(steps[0]?.kind === "turn" ? steps[0].message : "").toContain("ACK");
      expect(steps[2]?.kind === "turn" ? steps[2].message : "").toContain("COLOR=");
      expect(JSON.stringify(steps)).not.toContain("read_image");
      expect(imageResumeRecallTask.toolPolicy).toEqual({
        allowedTools: ["read_image"],
        allowedCapabilities: ["read"],
        allowedCommands: [],
      });
      expect(imageResumeRecallTask.statePolicy).toEqual({
        allowedMutations: ["infrastructure", "sessions", "image_sidecars"],
        requiredMutations: ["image_sidecars"],
      });
      expect(imageResumeRecallTask.limits).toMatchObject({
        maxToolCalls: 1,
        maxChangedFiles: 0,
        maxChangedBytes: 0,
        maxUserInputRequests: 0,
        maxChildAgents: 0,
      });
      expect(await imageResumeRecallTask.snapshotWorld(world)).toEqual({ color: world.color });
      expect(imageResumeRecallTask.verify).toBeUndefined();
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("accepts the exact seeded color value independent of natural color-name casing", async () => {
    const execution = await assembledExecution();
    replaceLastAssistantText(execution.turns[1]!.messages, `COLOR=${execution.world.color.toLowerCase()}`);

    expect(imageResumeRecallTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("rejects independent mutations of every required resume-image evidence surface", async () => {
    const execution = await assembledExecution();
    expect(imageResumeRecallTask.evaluate(execution)).toEqual({ passed: true });

    const mutations: Array<[string, (value: RuntimeEvalExecution<ImageResumeRecallWorld>) => void]> = [
      ["root termination", (value) => (value.termination = "runtime_error")],
      ["turn count", (value) => value.turns.pop()],
      ["turn index", (value) => (value.turns[1]!.index = 7)],
      ["turn completion", (value) => (value.turns[0]!.termination = "failed")],
      ["thread mismatch", (value) => (value.turns[1]!.threadId = "other-thread")],
      ["empty root thread", (value) => (value.session.threadId = "")],
      ["child session", (value) => value.childSessions.push({ threadId: "child", lines: [] })],
      ["compaction", (value) => value.compactions.push({} as never)],
      ["protocol action", (value) => value.protocolActions.push({} as never)],
      ["approval", (value) => value.approvals.push({})],
      ["input request", (value) => value.userInputRequests.push({})],
      ["first prompt leak", (value) => (value.turns[0]!.clientPrompt += ` ${value.world.color}`)],
      ["first prompt tool name", (value) => (value.turns[0]!.clientPrompt += " read_image")],
      ["wrong declared prompt", (value) => (value.turns[0]!.clientPrompt += " changed")],
      ["extra read", (value) => value.toolCalls.push(structuredClone(value.toolCalls[0]!))],
      ["failed read", (value) => (value.toolCalls[0]!.outcome = "runtime_error")],
      ["wrong read path", (value) => (value.toolCalls[0]!.input = { file_path: "$WORKSPACE/wrong.png" })],
      ["wrong read thread", (value) => (value.toolCalls[0]!.threadId = "other-thread")],
      ["wrong read sequence", (value) => (value.toolCalls[0]!.sequence = 2)],
      ["malformed read image", (value) => mutateTraceImageData(value, "bad")],
      ["moved lifecycle", moveLifecycleToSecondTurn],
      ["missing lifecycle", (value) => value.turns[0]!.runtimeEvents.splice(lifecycleIndex(value, "tool_start"), 1)],
      ["duplicate lifecycle", duplicateNotificationLifecycle],
      ["reordered lifecycle", reorderRuntimeLifecycle],
      ["malformed lifecycle image", malformedLifecycleImage],
      ["wrong lifecycle input", mutateLifecycleInput],
      ["errored lifecycle", markNotificationLifecycleErrored],
      ["wrong ACK", (value) => replaceLastAssistantText(value.turns[0]!.messages, "NO")],
      ["wrong answer", (value) => replaceLastAssistantText(value.turns[1]!.messages, "COLOR=GREEN")],
      ["missing session result", (value) => removeSessionToolResults(value)],
      ["duplicate session result", (value) => duplicateSessionToolResult(value)],
      ["wrong session result id", (value) => mutateSessionToolResult(value, (result) => (result.toolCallId = "other"))],
      ["wrong session result name", (value) => mutateSessionToolResult(value, (result) => (result.toolName = "read"))],
      ["errored session result", (value) => mutateSessionToolResult(value, (result) => (result.isError = true))],
      [
        "inline session image",
        (value) => mutateSessionImageData(value, solidColorPng(value.world.color).toString("base64")),
      ],
      ["malformed blob", (value) => mutateSessionImageData(value, "blob:not-a-hash")],
      ["mismatched blob", (value) => mutateSessionImageData(value, `blob:${"f".repeat(64)}`)],
      ["forged coupled blob", forgeCoupledBlobEvidence],
      ["missing sidecar", (value) => removeImageSidecars(value)],
      [
        "mismatched sidecar",
        (value) => (imageSidecarFinal(value).path = `.diligent/sessions/blobs/${"e".repeat(64)}.bin`),
      ],
      ["non-added sidecar", (value) => (imageSidecarDiff(value).change = "modified")],
      ["zero-size sidecar", (value) => (imageSidecarFinal(value).size = 0)],
      ["wrong nonzero sidecar size", (value) => (imageSidecarFinal(value).size += 1)],
      ["wrong sidecar digest", (value) => (imageSidecarFinal(value).sha256 = "d".repeat(64))],
      [
        "missing after resume",
        (value) => (value.threadReads = value.threadReads.filter((item) => item.phase !== "after_resume")),
      ],
      ["running after resume", (value) => (afterResume(value).response.isRunning = true)],
      ["malformed after resume", (value) => (afterResume(value).response.items = [])],
      ["errored after-resume result", markAfterResumeResultErrored],
      ["unredacted after-resume image", (value) => mutateAfterResumeImageData(value, "raw")],
      ["missing provider", (value) => value.providerCalls.pop()],
      ["extra provider", (value) => value.providerCalls.push(structuredClone(value.providerCalls[2]!))],
      ["provider order", (value) => value.providerCalls.reverse()],
      ["wrong provider session", (value) => (value.providerCalls[1]!.sessionId = "other-thread")],
      ["initial image leak", (value) => value.providerCalls[0]!.messages.items.push(imageBlock(value.world.color))],
      ["post-read image missing", (value) => removeProviderImages(value.providerCalls[1]!.messages.items)],
      ["post-read result errored", (value) => markProviderResultErrored(value, 1)],
      ["resumed image missing", (value) => removeProviderImages(value.providerCalls[2]!.messages.items)],
      ["resumed result link changed", (value) => mutateProviderResultId(value, 2)],
      ["resumed ACK missing", (value) => removeText(value.providerCalls[2]!.messages.items, "ACK")],
      [
        "resumed prompt missing",
        (value) => removeText(value.providerCalls[2]!.messages.items, value.turns[1]!.clientPrompt),
      ],
      ["tool not advertised", (value) => (value.providerCalls[0]!.tools.items = [])],
      ["raw base64 leak", (value) => value.logs.push({ message: "iVBOR" } as never)],
      ["protected hash mutation", (value) => (fixtureFinal(value).sha256 = "0".repeat(64))],
      ["protected size mutation", (value) => (fixtureFinal(value).size += 1)],
      ["protected kind mutation", (value) => (fixtureFinal(value).kind = "directory")],
      [
        "project manifest mutation",
        (value) => value.workspace.final.entries.push({ path: "extra", kind: "file", size: 1 }),
      ],
    ];

    for (const [label, mutate] of mutations) {
      const changed = structuredClone(execution);
      mutate(changed);
      const result = imageResumeRecallTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
  });

  test("materializes the PNG before and after restart while captured evidence stays redacted", async () => {
    for (const profile of [
      { provider: "openai" as const, model: "gpt-5.6-terra", effort: "medium" as const },
      { provider: "anthropic" as const, model: "claude-sonnet-5", effort: "medium" as const },
    ]) {
      const execution = await assembledExecution(profile);
      const serialized = JSON.stringify(execution);
      expect(imageResumeRecallTask.evaluate(execution)).toEqual({ passed: true });
      expect(execution.providerCalls).toHaveLength(3);
      expect(execution.threadReads.map((item) => item.phase)).toEqual(["after_turn", "after_resume", "after_turn"]);
      expect(serialized).not.toContain("iVBOR");
      expect(serialized).toContain("[base64 omitted]");
      expect(JSON.stringify(execution.session.lines)).toMatch(/blob:[0-9a-f]{64}/);
    }
  });
});

async function assembledExecution(
  profile: EvalProfile = { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
): Promise<RuntimeEvalExecution<ImageResumeRecallWorld>> {
  const result = await runRuntimeEvalExecution({
    task: imageResumeRecallTask,
    seed: "shared-seed-123",
    profile,
    streamFunction: imageResumeStream(),
  });
  expect(result.failures).toEqual([]);
  return result.execution as RuntimeEvalExecution<ImageResumeRecallWorld>;
}

function imageResumeStream(): StreamFunction {
  let call = 0;
  let color: ImageResumeRecallWorld["color"] | undefined;
  let firstPrompt = "";
  return (model, context, options) => {
    call += 1;
    const toolResults = context.messages.filter((message) => message.role === "tool_result");
    const pngs = collectPngBase64(context.messages);
    let response: Message;
    if (call === 1) {
      expect(toolResults).toHaveLength(0);
      expect(pngs).toHaveLength(0);
      firstPrompt = lastUserText(context);
      const path = firstPrompt.match(/\S+\.png/)?.[0];
      if (!path) throw new Error("Image fixture path was absent from the first prompt.");
      response = assistantMessage(
        [{ type: "tool_call", id: "resume-image", name: "read_image", input: { file_path: path } }],
        "tool_use",
      );
    } else if (call === 2) {
      expect(toolResults).toHaveLength(1);
      color = deriveColor(pngs);
      expect(lastUserText(context)).toBe(firstPrompt);
      response = assistantMessage([{ type: "text", text: "ACK" }]);
    } else {
      expect(call).toBe(3);
      expect(toolResults).toHaveLength(1);
      if (!color) throw new Error("The pre-restart image color was not derived.");
      expect(deriveColor(pngs)).toBe(color);
      expect(JSON.stringify(context.messages)).toContain("ACK");
      expect(lastUserText(context)).toContain("COLOR=");
      response = assistantMessage([{ type: "text", text: `COLOR=${color}` }]);
    }
    return sequenceStream([response])(model, context, options);
  };
}

function deriveColor(images: string[]): ImageResumeRecallWorld["color"] {
  expect(images).toHaveLength(1);
  if (images[0] === solidColorPng("RED").toString("base64")) return "RED";
  if (images[0] === solidColorPng("BLUE").toString("base64")) return "BLUE";
  throw new Error("Provider did not receive a loadable seeded PNG.");
}

function collectPngBase64(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectPngBase64);
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  const own =
    item.type === "base64" && item.media_type === "image/png" && typeof item.data === "string" ? [item.data] : [];
  return [...own, ...Object.values(item).flatMap(collectPngBase64)];
}

function lastUserText(context: StreamContext): string {
  const message = [...context.messages].reverse().find((item) => item.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function replaceLastAssistantText(messages: Message[], text: string): void {
  const message = [...messages].reverse().find((item) => item.role === "assistant");
  if (!message || message.role !== "assistant") throw new Error("Missing assistant message.");
  message.content = [{ type: "text", text }];
}

function walk(value: unknown, visit: (item: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit));
    return;
  }
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  visit(item);
  Object.values(item).forEach((child) => walk(child, visit));
}

function removeSessionToolResults(value: RuntimeEvalExecution<ImageResumeRecallWorld>): void {
  value.session.lines = value.session.lines.filter(
    (line) => (line as { message?: { role?: string } }).message?.role !== "tool_result",
  );
}

function duplicateSessionToolResult(value: RuntimeEvalExecution<ImageResumeRecallWorld>): void {
  const result = value.session.lines.find(
    (line) => (line as { message?: { role?: string } }).message?.role === "tool_result",
  );
  value.session.lines.push(structuredClone(result));
}

function mutateSessionToolResult(
  value: RuntimeEvalExecution<ImageResumeRecallWorld>,
  mutate: (item: Record<string, unknown>) => void,
): void {
  const result = value.session.lines.find(
    (line) => (line as { message?: { role?: string } }).message?.role === "tool_result",
  ) as { message?: Record<string, unknown> } | undefined;
  if (!result?.message) throw new Error("Missing session tool result.");
  mutate(result.message);
}

function mutateSessionImageData(value: RuntimeEvalExecution<ImageResumeRecallWorld>, data: string): void {
  walk(value.session.lines, (item) => {
    if (item.type === "base64" && item.media_type === "image/png") item.data = data;
  });
}

function mutateTraceImageData(value: RuntimeEvalExecution<ImageResumeRecallWorld>, data: string): void {
  walk(value.toolCalls[0]!.output, (item) => {
    if (item.type === "base64" && item.media_type === "image/png") item.data = data;
  });
}

function forgeCoupledBlobEvidence(value: RuntimeEvalExecution<ImageResumeRecallWorld>): void {
  const hash = "f".repeat(64);
  mutateSessionImageData(value, `blob:${hash}`);
  imageSidecarDiff(value).path = `.diligent/sessions/blobs/${hash}.bin`;
  const final = imageSidecarFinal(value);
  final.path = `.diligent/sessions/blobs/${hash}.bin`;
  final.sha256 = hash;
}

function removeImageSidecars(value: RuntimeEvalExecution<ImageResumeRecallWorld>): void {
  value.runtimeState.diff = value.runtimeState.diff.filter((item) => item.category !== "image_sidecars");
  value.runtimeState.final = value.runtimeState.final.filter((item) => item.category !== "image_sidecars");
}

function imageSidecarDiff(value: RuntimeEvalExecution<ImageResumeRecallWorld>) {
  return value.runtimeState.diff.find((item) => item.category === "image_sidecars" && item.path.endsWith(".bin"))!;
}

function imageSidecarFinal(value: RuntimeEvalExecution<ImageResumeRecallWorld>) {
  return value.runtimeState.final.find(
    (item) => item.category === "image_sidecars" && item.kind === "file" && item.path.endsWith(".bin"),
  )!;
}

function afterResume(value: RuntimeEvalExecution<ImageResumeRecallWorld>) {
  return value.threadReads.find((item) => item.phase === "after_resume")!;
}

function afterResumeResult(value: RuntimeEvalExecution<ImageResumeRecallWorld>): Record<string, unknown> {
  const result = afterResume(value).response.items.find(
    (item) =>
      (item as { type?: string }).type === "toolCall" && (item as { durationMs?: number }).durationMs !== undefined,
  );
  if (!result) throw new Error("Missing completed after-resume tool result.");
  return result as unknown as Record<string, unknown>;
}

function markAfterResumeResultErrored(value: RuntimeEvalExecution<ImageResumeRecallWorld>): void {
  afterResumeResult(value).isError = true;
}

function mutateAfterResumeImageData(value: RuntimeEvalExecution<ImageResumeRecallWorld>, data: string): void {
  walk(afterResumeResult(value), (item) => {
    if (item.type === "base64" && item.media_type === "image/png") item.data = data;
  });
}

function imageBlock(color: ImageResumeRecallWorld["color"]) {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: solidColorPng(color).toString("base64") },
  };
}

function removeProviderImages(value: unknown): void {
  walk(value, (item) => {
    for (const [key, child] of Object.entries(item)) {
      if (Array.isArray(child))
        item[key] = child.filter(
          (block) => !(block && typeof block === "object" && (block as { type?: string }).type === "image"),
        );
    }
  });
}

function removeText(value: unknown, text: string): void {
  walk(value, (item) => {
    for (const [key, child] of Object.entries(item))
      if (typeof child === "string" && child.includes(text)) item[key] = child.replace(text, "");
  });
}

function fixtureFinal(value: RuntimeEvalExecution<ImageResumeRecallWorld>) {
  return value.workspace.final.entries.find((item) => item.path === value.world.fixturePath)!;
}

function lifecycleIndex(value: RuntimeEvalExecution<ImageResumeRecallWorld>, type: string): number {
  return value.turns[0]!.runtimeEvents.findIndex((event) => (event as { type?: string }).type === type);
}

function moveLifecycleToSecondTurn(value: RuntimeEvalExecution<ImageResumeRecallWorld>): void {
  const index = lifecycleIndex(value, "tool_start");
  value.turns[1]!.runtimeEvents.push(value.turns[0]!.runtimeEvents.splice(index, 1)[0]!);
}

function duplicateNotificationLifecycle(value: RuntimeEvalExecution<ImageResumeRecallWorld>): void {
  const notification = value.turns[0]!.notifications.find(
    (item) =>
      item.method === "agent/event" && (item.params as { event?: { type?: string } }).event?.type === "tool_start",
  );
  value.turns[0]!.notifications.push(structuredClone(notification!));
}

function reorderRuntimeLifecycle(value: RuntimeEvalExecution<ImageResumeRecallWorld>): void {
  const start = lifecycleIndex(value, "tool_start");
  const end = lifecycleIndex(value, "tool_end");
  [value.turns[0]!.runtimeEvents[start], value.turns[0]!.runtimeEvents[end]] = [
    value.turns[0]!.runtimeEvents[end]!,
    value.turns[0]!.runtimeEvents[start]!,
  ];
}

function malformedLifecycleImage(value: RuntimeEvalExecution<ImageResumeRecallWorld>): void {
  const event = value.turns[0]!.runtimeEvents[lifecycleIndex(value, "tool_end")] as {
    outputImages?: Array<{ source?: { data?: string } }>;
  };
  event.outputImages![0]!.source!.data = "bad";
}

function mutateLifecycleInput(value: RuntimeEvalExecution<ImageResumeRecallWorld>): void {
  const event = value.turns[0]!.runtimeEvents[lifecycleIndex(value, "tool_start")] as { input?: unknown };
  event.input = { file_path: "$WORKSPACE/wrong.png" };
}

function markNotificationLifecycleErrored(value: RuntimeEvalExecution<ImageResumeRecallWorld>): void {
  const notification = value.turns[0]!.notifications.find(
    (item) =>
      item.method === "agent/event" && (item.params as { event?: { type?: string } }).event?.type === "tool_end",
  );
  const event = (notification!.params as { event: Record<string, unknown> }).event;
  event.isError = true;
}

function providerResult(value: RuntimeEvalExecution<ImageResumeRecallWorld>, index: number): Record<string, unknown> {
  let found: Record<string, unknown> | undefined;
  walk(value.providerCalls[index]!.messages.items, (item) => {
    if (item.role === "tool_result") found = item;
  });
  if (!found) throw new Error("Missing provider tool result.");
  return found;
}

function markProviderResultErrored(value: RuntimeEvalExecution<ImageResumeRecallWorld>, index: number): void {
  providerResult(value, index).isError = true;
}

function mutateProviderResultId(value: RuntimeEvalExecution<ImageResumeRecallWorld>, index: number): void {
  providerResult(value, index).toolCallId = "other";
}
