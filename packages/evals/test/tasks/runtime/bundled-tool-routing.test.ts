// @summary Contract, assembled-runtime execution, and mutation coverage for bundled-tool-routing

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@diligent/core/message-contract";
import { DEFAULT_PROFILES } from "../../../src/profiles";
import { runRuntimeEvalExecution } from "../../../src/runner/runtime-execution";
import { removeTemporaryRoot } from "../../../src/runner/runtime-workspace";
import type { RuntimeEvalExecution } from "../../../src/runtime-task";
import type { EvalProfile } from "../../../src/task";
import { type BundledToolRoutingWorld, bundledToolRoutingTask } from "../../../src/tasks/runtime/bundled-tool-routing";
import { assistantMessage, sequenceStream } from "../../helpers/fake-stream";

describe("bundled-tool-routing", () => {
  test("defines exactly two strict fixture-owned providers and a receipt-free natural prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-bundled-routing-"));
    try {
      const world = await bundledToolRoutingTask.setup("shared-seed-123", root);
      const again = await bundledToolRoutingTask.setup("shared-seed-123", root);
      expect({ ...again, providerAssembly: [], executions: [] }).toEqual({
        ...world,
        providerAssembly: [],
        executions: [],
      });
      const providers = await bundledToolRoutingTask.createBundledToolProviders!(world);
      expect(providers).toHaveLength(2);
      expect(providers.map((provider) => provider.id)).toEqual([
        "eval-field-journey-provider",
        "eval-archive-collection-provider",
      ]);
      const tools = (await Promise.all(providers.map((provider) => provider.createTools({ cwd: root })))).flat();
      expect(tools.map((tool) => tool.name)).toEqual(["coordinate_field_journey", "schedule_archive_collection"]);
      expect(tools[0]!.parameters.safeParse(world.request).success).toBe(true);
      expect(tools[0]!.parameters.safeParse({ ...world.request, extra: true }).success).toBe(false);
      expect(
        tools[0]!.parameters.safeParse({
          ...world.request,
          route: { ...world.request.route, extra: true },
        }).success,
      ).toBe(false);
      expect(world.clientPrompt).not.toContain(world.receipt);
      expect(world.clientPrompt).not.toContain(world.decoyReceipt);
      expect(world.clientPrompt).not.toMatch(
        /coordinate_field_journey|schedule_archive_collection|assignment_ref|country_code|travel_window|accessibility_support/,
      );
      expect(bundledToolRoutingTask.toolPolicy).toEqual({
        allowedTools: ["coordinate_field_journey", "schedule_archive_collection"],
        allowedCapabilities: ["execute"],
        allowedCommands: [],
      });
      expect(bundledToolRoutingTask.limits).toMatchObject({
        maxTurns: 2,
        maxToolCalls: 1,
        maxChangedFiles: 0,
        maxChangedBytes: 0,
        maxUserInputRequests: 0,
        maxChildAgents: 0,
      });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("runs natural-intent routing through real runtime assembly for both default profiles", async () => {
    expect(DEFAULT_PROFILES).toHaveLength(2);
    for (const profile of DEFAULT_PROFILES) {
      const execution = await assembledExecution(profile);
      expect(bundledToolRoutingTask.evaluate(execution), profile.provider).toEqual({ passed: true });
      expect(execution.world.providerAssembly).toEqual([
        { providerId: "eval-field-journey-provider", cwd: "$WORKSPACE" },
        { providerId: "eval-archive-collection-provider", cwd: "$WORKSPACE" },
      ]);
      expect(execution.world.executions).toEqual([
        {
          providerId: "eval-field-journey-provider",
          toolName: "coordinate_field_journey",
          input: execution.world.request,
        },
      ]);
      expect(execution.providerCalls).toHaveLength(2);
      expect(execution.providerCalls.every((call) => call.tools.items.length === 2)).toBe(true);
      expect(execution.toolCalls).toHaveLength(1);
      expect(finalText(execution)).toBe(execution.world.receipt);
    }
  });

  test("accepts provider-native progress text beside one exact bundled tool call", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!, true);

    expect(bundledToolRoutingTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("accepts a bounded confirmation wrapper around the exclusive intended receipt", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[1]!, false, "Confirmed: ");

    expect(finalText(execution)).toBe(`Confirmed: ${execution.world.receipt}`);
    expect(bundledToolRoutingTask.evaluate(execution)).toEqual({ passed: true });

    const missingReceipt = structuredClone(execution);
    setFinal(missingReceipt, "Confirmed");
    expect(bundledToolRoutingTask.evaluate(missingReceipt)).toMatchObject({
      passed: false,
      code: "bundled_tool_routing.final",
    });
  });

  test("rejects the independent routing, nesting, lifecycle, persistence, and isolation mutation matrix", async () => {
    const baseline = await assembledExecution(DEFAULT_PROFILES[0]!);
    expect(bundledToolRoutingTask.evaluate(baseline)).toEqual({ passed: true });
    const cases: Array<[string, (value: RuntimeEvalExecution<BundledToolRoutingWorld>) => void]> = [
      ["task", (value) => (value.taskId = "other")],
      ["seed", (value) => (value.world.seed = "wrong")],
      ["prompt", (value) => (value.turns[0]!.clientPrompt += " coordinate_field_journey")],
      ["early receipt", (value) => value.providerCalls[0]!.messages.items.push(value.world.receipt)],
      ["termination", (value) => (value.termination = "runtime_error")],
      ["profile", (value) => (value.profile.model = "wrong")],
      ["extra turn", (value) => value.turns.push(structuredClone(value.turns[0]!))],
      ["thread root", (value) => (value.threadCwd = "$WORKSPACE/subdir")],
      ["thread profile", (value) => (value.threadReads[0]!.response.currentEffort = "low")],
      ["default mode", (value) => (value.advertisedTools[0]!.mode = "plan")],
      ["missing advertised", (value) => removeAdvertised(value, "coordinate_field_journey")],
      ["duplicate advertised", (value) => value.advertisedTools[0]!.tools.push("coordinate_field_journey")],
      ["extra provider tool", (value) => value.providerCalls[0]!.tools.items.push({} as never)],
      ["missing provider tool", (value) => value.providerCalls[0]!.tools.items.pop()],
      ["reordered provider tools", (value) => value.providerCalls[0]!.tools.items.reverse()],
      ["duplicate provider tool", duplicateProviderTool],
      ["definition description", mutateDefinitionDescription],
      ["definition schema", mutateDefinitionSchema],
      ["missing assembly", (value) => value.world.providerAssembly.pop()],
      ["reordered assembly", (value) => value.world.providerAssembly.reverse()],
      ["duplicate assembly", (value) => value.world.providerAssembly.push(value.world.providerAssembly[0]!)],
      ["missing trace", (value) => value.toolCalls.pop()],
      ["extra trace", (value) => value.toolCalls.push(structuredClone(value.toolCalls[0]!))],
      ["decoy selection", selectDecoy],
      ["trace id", (value) => (value.toolCalls[0]!.toolCallId = "")],
      ["trace actor", (value) => (value.toolCalls[0]!.threadId = "child")],
      ["trace outcome", (value) => (value.toolCalls[0]!.outcome = "runtime_error")],
      ["missing nested branch", (value) => delete (value.toolCalls[0]!.input as Record<string, unknown>).service],
      ["extra nested root", (value) => ((value.toolCalls[0]!.input as Record<string, unknown>).extra = true)],
      ["missing nested leaf", removeNestedLeaf],
      ["extra nested leaf", addNestedLeaf],
      ["nested type", mutateNestedType],
      ["nested value", mutateNestedValue],
      ["array reorder", reorderParticipants],
      ["array omission", omitParticipant],
      ["array duplicate", duplicateParticipant],
      ["raw output", (value) => ((value.toolCalls[0]!.output as Record<string, unknown>).output = "wrong")],
      ["raw output extra", (value) => ((value.toolCalls[0]!.output as Record<string, unknown>).extra = true)],
      ["missing execution", (value) => value.world.executions.pop()],
      ["decoy execution", addDecoyExecution],
      ["provider missing", (value) => value.providerCalls.pop()],
      ["provider extra", (value) => value.providerCalls.push(structuredClone(value.providerCalls[1]!))],
      ["provider reorder", (value) => value.providerCalls.reverse()],
      ["provider sequence", (value) => (value.providerCalls[1]!.sequence = 1)],
      ["provider model", (value) => (value.providerCalls[1]!.model.modelId = "wrong")],
      ["provider effort", (value) => (value.providerCalls[1]!.streamOptions.effort = "wrong")],
      ["provider session", (value) => (value.providerCalls[1]!.sessionId = "wrong")],
      ["provider bounds", (value) => (value.providerCalls[1]!.bounds.omittedNestedItems += 1)],
      ["provider max tokens", (value) => (value.providerCalls[1]!.streamOptions.maxTokens = 1)],
      ["provider message omission", (value) => value.providerCalls[1]!.messages.items.pop()],
      ["provider message extra", (value) => value.providerCalls[1]!.messages.items.push({})],
      ["provider message reorder", (value) => value.providerCalls[1]!.messages.items.reverse()],
      ["provider input divergence", mutateProviderInput],
      ["provider result divergence", mutateProviderResult],
      ["turn omission", (value) => value.turns[0]!.messages.pop()],
      ["turn extra", (value) => value.turns[0]!.messages.push(structuredClone(value.turns[0]!.messages[3]!))],
      ["turn reorder", (value) => value.turns[0]!.messages.reverse()],
      ["turn duplicate result", duplicateTurnResult],
      ["result linkage", (value) => (toolResult(value).toolCallId = "wrong")],
      ["result receipt", (value) => (toolResult(value).output = "wrong")],
      ["result render", (value) => (toolResult(value).render = { inputSummary: "unexpected" })],
      ["final prose", (value) => setFinal(value, `${value.world.receipt} complete`)],
      ["final decoy", (value) => setFinal(value, value.world.decoyReceipt)],
      ["core omission", (value) => value.turns[0]!.coreEvents.splice(5, 1)],
      ["core extra", (value) => value.turns[0]!.coreEvents.push(value.turns[0]!.coreEvents[0]!)],
      ["core reorder", (value) => value.turns[0]!.coreEvents.reverse()],
      ["core linkage", mutateCoreLinkage],
      ["coupled lifecycle final", mutateCoupledLifecycleFinal],
      ["runtime divergence", (value) => value.turns[0]!.runtimeEvents.pop()],
      ["notification divergence", removeAgentNotification],
      ["session omission", removeSessionReceipt],
      ["session tool input", mutateSessionToolInput],
      ["session final", mutateSessionFinal],
      ["session extra", (value) => value.session.lines.push({ type: "message", message: {} })],
      ["session reorder", (value) => value.session.lines.reverse()],
      ["session linkage", (value) => (value.session.threadId = "wrong")],
      ["thread omission", removeThreadReceipt],
      ["thread tool input", mutateThreadToolInput],
      ["thread final", mutateThreadFinal],
      ["thread extra", (value) => value.threadReads[0]!.response.items.push({} as never)],
      ["thread reorder", (value) => value.threadReads[0]!.response.items.reverse()],
      ["thread linkage", (value) => (value.threadReads[0]!.response.entryCount += 1)],
      ["manifest hash", (value) => (entry(value, "manifest.json", "initial").sha256 = "wrong")],
      ["manifest coupled", mutateCoupledManifest],
      ["project mutation", addProjectMutation],
      ["runtime knowledge", addForbiddenState],
      ["output file", (value) => value.toolOutputFiles.push({ path: "x", bytes: 1, sha256: "x" })],
      ["compaction", (value) => value.compactions.push({} as never)],
      ["action", (value) => value.protocolActions.push({} as never)],
      ["approval", (value) => value.approvals.push({})],
      ["input", (value) => value.userInputRequests.push({})],
      ["child", (value) => value.childSessions.push({ threadId: "child", lines: [] })],
      ["verifier", addVerifier],
      ["execution error", (value) => (value.error = { name: "Error", message: "unexpected" } as never)],
      ["report decoy leak", (value) => value.logs.push({ level: "info", message: value.world.decoyReceipt } as never)],
    ];
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      mutate(changed);
      const result = bundledToolRoutingTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
    expect(bundledToolRoutingTask.evaluate(structuredClone(baseline))).toEqual({ passed: true });
  });
});

async function assembledExecution(
  profile: EvalProfile,
  includeProgressText = false,
  finalPrefix = "",
): Promise<RuntimeEvalExecution<BundledToolRoutingWorld>> {
  const seed = "shared-seed-123";
  let call = 0;
  const result = await runRuntimeEvalExecution({
    task: bundledToolRoutingTask,
    seed,
    profile,
    streamFunction(model, context, options) {
      call += 1;
      const response =
        call === 1
          ? assistantMessage(
              [
                ...(includeProgressText ? [{ type: "text" as const, text: "Arranging the field journey now." }] : []),
                {
                  type: "tool_call",
                  id: "journey-call-1",
                  name: "coordinate_field_journey",
                  input: requestFor(seed),
                },
              ],
              "tool_use",
            )
          : assistantMessage([{ type: "text", text: `${finalPrefix}${token(seed, "JOURNEY_RECEIPT")}` }]);
      return sequenceStream([response])(model, context, options);
    },
  });
  expect(result.failures, JSON.stringify(result.failures)).toEqual([]);
  expect(result.execution.termination).toBe("completed");
  return result.execution as RuntimeEvalExecution<BundledToolRoutingWorld>;
}

function requestFor(seed: string) {
  return {
    assignment_ref: token(seed, "ASSIGNMENT"),
    route: {
      destination: { city: token(seed, "CITY"), country_code: "KR" },
      travel_window: { outbound: "2026-09-17", inbound: "2026-09-21" },
      participants: [
        { identity: token(seed, "LEAD"), duty: "lead" },
        { identity: token(seed, "OBSERVER"), duty: "observer" },
      ],
    },
    service: { cabin: "quiet", accessibility_support: false },
  };
}

function token(seed: string, prefix: string): string {
  return `${prefix}_${seed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "seed"}`;
}

function finalText(value: RuntimeEvalExecution<BundledToolRoutingWorld>): string {
  const final = value.turns[0]!.messages.at(-1);
  return final?.role === "assistant" && Array.isArray(final.content)
    ? final.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    : "";
}

function removeAdvertised(value: RuntimeEvalExecution<BundledToolRoutingWorld>, name: string) {
  value.advertisedTools[0]!.tools = value.advertisedTools[0]!.tools.filter((tool) => tool !== name);
}

function duplicateProviderTool(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  value.providerCalls[0]!.tools.items[1] = structuredClone(value.providerCalls[0]!.tools.items[0]!);
}

function intendedDefinition(value: RuntimeEvalExecution<BundledToolRoutingWorld>): Record<string, unknown> {
  return value.providerCalls[0]!.tools.items.find(
    (item) => (item as { name?: string }).name === "coordinate_field_journey",
  ) as unknown as Record<string, unknown>;
}

function mutateDefinitionDescription(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  intendedDefinition(value).description = "wrong";
}

function mutateDefinitionSchema(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const schema = intendedDefinition(value).inputSchema as Record<string, unknown>;
  schema.additionalProperties = true;
}

function selectDecoy(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  value.toolCalls[0]!.name = "schedule_archive_collection";
  value.world.executions[0]!.providerId = "eval-archive-collection-provider";
  value.world.executions[0]!.toolName = "schedule_archive_collection";
}

function routeInput(value: RuntimeEvalExecution<BundledToolRoutingWorld>): Record<string, unknown> {
  return (value.toolCalls[0]!.input as { route: Record<string, unknown> }).route;
}

function removeNestedLeaf(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  delete (routeInput(value).destination as Record<string, unknown>).country_code;
}

function addNestedLeaf(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  (routeInput(value).destination as Record<string, unknown>).extra = true;
}

function mutateNestedType(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  (value.toolCalls[0]!.input as { service: Record<string, unknown> }).service.accessibility_support = "false";
}

function mutateNestedValue(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  (routeInput(value).destination as Record<string, unknown>).city = "wrong";
}

function participants(value: RuntimeEvalExecution<BundledToolRoutingWorld>): unknown[] {
  return routeInput(value).participants as unknown[];
}

function reorderParticipants(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  participants(value).reverse();
}

function omitParticipant(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  participants(value).pop();
}

function duplicateParticipant(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  participants(value)[1] = structuredClone(participants(value)[0]);
}

function addDecoyExecution(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  value.world.executions.push({
    providerId: "eval-archive-collection-provider",
    toolName: "schedule_archive_collection",
    input: {},
  });
}

function mutateProviderInput(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const assistant = value.providerCalls[1]!.messages.items[1] as { content: Array<{ input?: unknown }> };
  assistant.content[0]!.input = { wrong: true };
}

function mutateProviderResult(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  (value.providerCalls[1]!.messages.items[2] as { output?: string }).output = "wrong";
}

function toolResult(value: RuntimeEvalExecution<BundledToolRoutingWorld>): Message & Record<string, unknown> {
  return value.turns[0]!.messages[2] as Message & Record<string, unknown>;
}

function duplicateTurnResult(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  value.turns[0]!.messages.splice(3, 0, structuredClone(value.turns[0]!.messages[2]!));
}

function setFinal(value: RuntimeEvalExecution<BundledToolRoutingWorld>, text: string) {
  const final = value.turns[0]!.messages[3] as Message & { content: Array<{ type: "text"; text: string }> };
  final.content = [{ type: "text", text }];
}

function mutateCoreLinkage(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const event = value.turns[0]!.coreEvents.find((item) => item.event.type === "tool_start")!.event as unknown as Record<
    string,
    unknown
  >;
  event.toolCallId = "wrong";
}

function mutateCoupledLifecycleFinal(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const surfaces: unknown[][] = [
    value.turns[0]!.coreEvents.map((item) => item.event),
    value.turns[0]!.runtimeEvents,
    value.turns[0]!.notifications.filter((notice) => notice.method === "agent/event").map(
      (notice) => (notice.params as { event: unknown }).event,
    ),
  ];
  for (const surface of surfaces) {
    const event = surface.findLast((item) => (item as { type?: string }).type === "message_end") as {
      message: Extract<Message, { role: "assistant" }>;
    };
    event.message.content = [{ type: "text", text: "wrong" }];
  }
}

function removeAgentNotification(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const index = value.turns[0]!.notifications.findIndex((notice) => notice.method === "agent/event");
  value.turns[0]!.notifications.splice(index, 1);
}

function removeSessionReceipt(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const index = value.session.lines.findIndex((line) => JSON.stringify(line).includes(value.world.receipt));
  value.session.lines.splice(index, 1);
}

function mutateSessionToolInput(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const line = value.session.lines.find((item) => JSON.stringify(item).includes(value.toolCalls[0]!.toolCallId)) as {
    message: Extract<Message, { role: "assistant" }>;
  };
  const block = line.message.content[0];
  if (block?.type !== "tool_call") throw new Error("Missing session tool call.");
  block.input = { wrong: true };
}

function mutateSessionFinal(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const line = value.session.lines.findLast(
    (item) => (item as { message?: { role?: string } }).message?.role === "assistant",
  ) as { message: Extract<Message, { role: "assistant" }> };
  line.message.content = [{ type: "text", text: "wrong" }];
}

function removeThreadReceipt(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const items = value.threadReads[0]!.response.items;
  const index = items.findIndex((item) => JSON.stringify(item).includes(value.world.receipt));
  items.splice(index, 1);
}

function mutateThreadToolInput(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const item = value.threadReads[0]!.response.items.find(
    (candidate) => candidate.type === "toolCall" && candidate.toolCallId === value.toolCalls[0]!.toolCallId,
  );
  if (!item || item.type !== "toolCall") throw new Error("Missing thread tool item.");
  item.input = { wrong: true };
}

function mutateThreadFinal(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  const item = value.threadReads[0]!.response.items.findLast((candidate) => candidate.type === "agentMessage");
  if (!item || item.type !== "agentMessage") throw new Error("Missing thread final agent item.");
  item.message.content = [{ type: "text", text: "wrong" }];
}

function entry(value: RuntimeEvalExecution<BundledToolRoutingWorld>, path: string, phase: "initial" | "final") {
  return value.workspace[phase].entries.find((item) => item.path === path)!;
}

function mutateCoupledManifest(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  entry(value, "manifest.json", "initial").sha256 = "coupled";
  entry(value, "manifest.json", "final").sha256 = "coupled";
}

function addProjectMutation(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  value.workspace.final.entries.push({ path: "changed.txt", kind: "file", size: 1, sha256: "x" });
}

function addForbiddenState(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  value.runtimeState.diff.push({ path: "knowledge", category: "knowledge", change: "added" });
}

function addVerifier(value: RuntimeEvalExecution<BundledToolRoutingWorld>) {
  value.verifier = { argv: [], exitCode: 0, elapsedMs: 0, stdout: "", stderr: "", timedOut: false };
}
