// @summary Contract and assembled-runtime coverage for MCP resource grounding

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamContext } from "@diligent/core/provider-contract";
import { DEFAULT_PROFILES } from "../../../src/profiles";
import { runRuntimeEvalExecution } from "../../../src/runner/runtime-execution";
import { removeTemporaryRoot } from "../../../src/runner/runtime-workspace";
import type { RuntimeEvalExecution } from "../../../src/runtime-task";
import type { EvalProfile } from "../../../src/task";
import {
  type McpResourceGroundingWorld,
  mcpResourceGroundingTask,
} from "../../../src/tasks/runtime/mcp-resource-grounding";
import { assistantMessage, sequenceStream } from "../../helpers/fake-stream";

describe("mcp-resource-grounding", () => {
  test("does not gate MCP resource choice on persistence mirrors or verifier wording", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!);
    execution.session.lines = [];
    execution.threadReads = [];
    execution.turns[0]!.coreEvents = [];
    execution.turns[0]!.runtimeEvents = [];
    execution.turns[0]!.notifications = [];
    execution.verifier!.argv = ["deterministic-verifier"];
    execution.verifier!.stdout = "alternate success wording\n";
    expect(mcpResourceGroundingTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("reports an additional bounded in-scope resource listing as diagnostic", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!);
    const extraList = structuredClone(execution.toolCalls[0]!);
    extraList.toolCallId = "additional-resource-list";
    execution.toolCalls.splice(1, 0, extraList);
    execution.toolCalls.forEach((call, index) => (call.sequence = index + 1));
    expect(mcpResourceGroundingTask.evaluate(execution)).toMatchObject({
      passed: true,
      diagnostics: [{ code: "mcp_resource.additional_safe_discovery" }],
    });
  });

  test("defines a fixture-local stdio MCP resource grounding contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-mcp-resource-"));
    try {
      const world = await mcpResourceGroundingTask.setup("shared-seed-123", root);
      const config = await mcpResourceGroundingTask.createRuntimeConfig(world, DEFAULT_PROFILES[0]!);
      expect(mcpResourceGroundingTask.id).toBe("mcp-resource-grounding");
      expect(mcpResourceGroundingTask.toolPolicy).toEqual({
        allowedTools: ["mcp_list_resources", "mcp_read_resource", "apply_patch", "edit"],
        allowedCapabilities: ["execute", "write"],
        allowedCommands: [],
      });
      expect(config.diligent.mcp).toEqual({
        toolLoading: "eager",
        lazyThreshold: 10,
        maxOutputTokens: 1_337,
        resources: true,
        prompts: false,
      });
      expect(config.diligent.mcpServers).toEqual({
        "fixture-reference": {
          type: "stdio",
          command: process.execPath,
          args: [world.entryPath],
          cwd: root,
          startupTimeoutMs: 5_000,
          toolTimeoutMs: 5_000,
        },
      });
      expect(mcpResourceGroundingTask.limits).toMatchObject({
        maxTurns: 4,
        maxToolCalls: 5,
        maxChangedFiles: 1,
        maxChangedBytes: world.expected.length,
        maxUserInputRequests: 0,
        maxChildAgents: 0,
      });
      expect(world.resourceUris).toHaveLength(3);
      expect(new Set(world.resourceUris).size).toBe(3);
      expect(world.clientPrompt).not.toContain(world.fact);
      expect(world.resourceUris.every((uri) => !world.clientPrompt.includes(uri))).toBe(true);
      expect(world.decoyFacts.every((fact) => !world.clientPrompt.includes(fact))).toBe(true);
      expect(world.clientPrompt).not.toMatch(/mcp_list_resources|mcp_read_resource|apply_patch/);
      expect(world.entryContent).toContain("StdioServerTransport");
      expect(world.entryContent).toContain("registerResource");
      expect(world.entryContent).toContain("Archived orbital relay handoff schedule value:");
      expect(world.entryContent).toContain("Terrestrial relay handoff authorization value:");
      expect(world.entryContent).toContain('process.on("exit"');
      expect(world.protectedPaths).toEqual(["mcp/server.js", "package.json", "manifest.json", ".git/.keep"]);
      expect(world.allowedChanges).toEqual(["grounded-answer.txt"]);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("runs list, intended read, exact write, and final response for both default profiles", async () => {
    expect(DEFAULT_PROFILES).toHaveLength(2);
    for (const profile of DEFAULT_PROFILES) {
      const execution = await assembledExecution(profile);
      expect(mcpResourceGroundingTask.evaluate(execution), profile.provider).toEqual({ passed: true });
      expect(execution.toolCalls.map((call) => call.name)).toEqual([
        "mcp_list_resources",
        "mcp_read_resource",
        profile.provider === "anthropic" ? "edit" : "apply_patch",
      ]);
      expect(execution.approvals).toHaveLength(1);
      expect(execution.workspace.final.entries.find((entry) => entry.path === "grounded-answer.txt")?.sha256).toBe(
        execution.world.expectedHash,
      );
    }
  });

  test("accepts runtime-generated call ids, exact list scope, provider progress blocks, and patch envelope whitespace", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!, {
      includeProgressText: true,
      scopeResourceList: true,
      trailingPatchNewline: true,
    });
    const ids = ["runtime-list-call", "runtime-read-call", "runtime-write-call"];
    for (const [index, original] of [
      "resource-list-call-1",
      "resource-read-call-2",
      "resource-write-call-3",
    ].entries()) {
      replaceDeep(execution, (candidate) => candidate === original, ids[index]);
    }
    expect(execution.toolCalls[0]!.input).toEqual({ server: "fixture-reference" });
    expect((execution.toolCalls[2]!.input as { patch: string }).patch.endsWith("*** End Patch\n")).toBe(true);
    expect(execution.turns[0]!.coreEvents.filter((item) => item.event.type === "message_delta").length).toBeGreaterThan(
      1,
    );
    expect(mcpResourceGroundingTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("accepts omission of the provider edit flag when the runtime records its false schema default", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "anthropic")!;
    const execution = await assembledExecution(profile);
    for (const surface of [execution.providerCalls, execution.turns, execution.session, execution.threadReads]) {
      removePersistedEditDefault(surface);
    }
    expect(execution.toolCalls[2]!.input).toMatchObject({ replace_all: false });
    expect(mcpResourceGroundingTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("rejects the independent resource, URI, approval, artifact, persistence, lifecycle, and isolation mutation matrix", async () => {
    const baseline = await assembledExecution(DEFAULT_PROFILES[0]!);
    expect(mcpResourceGroundingTask.evaluate(baseline)).toEqual({ passed: true });
    const cases: Array<[string, (value: RuntimeEvalExecution<McpResourceGroundingWorld>) => void]> = [
      ["task id", (value) => (value.taskId = "other")],
      ["seed linkage", (value) => (value.world.seed = "wrong")],
      ["world fact", (value) => (value.world.fact = "wrong")],
      ["world intended URI", (value) => (value.world.intendedUri = value.world.resourceUris[1]!)],
      ["world resources omission", (value) => value.world.resources.pop()],
      ["world resources reorder", (value) => value.world.resources.reverse()],
      ["world decoy fact", (value) => (value.world.decoyFacts[0] = "wrong")],
      ["prompt fact leak", (value) => (value.turns[0]!.clientPrompt += ` ${value.world.fact}`)],
      ["prompt URI leak", (value) => (value.turns[0]!.clientPrompt += ` ${value.world.intendedUri}`)],
      ["prompt proxy leak", (value) => (value.turns[0]!.clientPrompt += " mcp_read_resource")],
      ["termination", (value) => (value.termination = "runtime_error")],
      ["execution error", (value) => (value.error = { name: "Error", message: "unexpected" })],
      ["profile model", (value) => (value.profile.model = "wrong")],
      ["profile effort", (value) => (value.profile.effort = "low" as never)],
      ["extra turn", (value) => value.turns.push(structuredClone(value.turns[0]!))],
      ["thread cwd", (value) => (value.threadCwd = "$WORKSPACE/subdir")],
      ["thread model", (value) => (value.threadReads[0]!.response.currentModel!.modelId = "wrong")],
      ["advertised mode", (value) => (value.advertisedTools[0]!.mode = "plan")],
      ["missing list advertisement", (value) => removeAdvertised(value, "mcp_list_resources")],
      ["missing read advertisement", (value) => removeAdvertised(value, "mcp_read_resource")],
      ["missing write advertisement", (value) => removeAdvertised(value, "apply_patch")],
      ["reordered advertisements", reorderAdvertised],
      ["duplicate advertisement", (value) => value.advertisedTools[0]!.tools.push("mcp_read_resource")],
      [
        "extra direct MCP advertisement",
        (value) => value.advertisedTools[0]!.tools.push("mcp__fixture-reference__unexpected_direct_tool"),
      ],
      [
        "extra advertisement snapshot",
        (value) => value.advertisedTools.push(structuredClone(value.advertisedTools[0]!)),
      ],
      ["missing provider call", (value) => value.providerCalls.pop()],
      ["extra provider call", (value) => value.providerCalls.push(structuredClone(value.providerCalls[3]!))],
      ["reordered provider calls", (value) => value.providerCalls.reverse()],
      ["provider sequence", (value) => (value.providerCalls[1]!.sequence = 1)],
      ["provider model", (value) => (value.providerCalls[1]!.model.modelId = "wrong")],
      ["provider effort", (value) => (value.providerCalls[1]!.streamOptions.effort = "wrong")],
      ["provider session", (value) => (value.providerCalls[1]!.sessionId = "wrong")],
      ["provider stream session", (value) => (value.providerCalls[1]!.streamOptions.sessionId = "wrong")],
      ["provider max tokens", (value) => (value.providerCalls[1]!.streamOptions.maxTokens = 1)],
      ["provider message omission", (value) => value.providerCalls[3]!.messages.items.pop()],
      ["provider message extra", (value) => value.providerCalls[1]!.messages.items.push({})],
      ["provider message reorder", (value) => value.providerCalls[3]!.messages.items.reverse()],
      ["missing definition", (value) => value.providerCalls[0]!.tools.items.pop()],
      ["extra definition", (value) => value.providerCalls[0]!.tools.items.push({} as never)],
      ["reordered definitions", (value) => value.providerCalls[0]!.tools.items.reverse()],
      ["write definition", (value) => (definition(value, 0).description = "wrong")],
      ["list definition", (value) => (definition(value, 1).description = "wrong")],
      ["read definition", (value) => (definition(value, 2).description = "wrong")],
      ["definition extra field", (value) => (definition(value, 2).unexpected = true)],
      ["list schema", (value) => delete schemaProperties(definition(value, 1)).server],
      ["read schema", (value) => delete schemaProperties(definition(value, 2)).uri],
      ["later definition divergence", (value) => (definition(value, 2, 1).description = "wrong")],
      ["missing list trace", (value) => value.toolCalls.shift()],
      ["missing read trace", (value) => value.toolCalls.splice(1, 1)],
      ["missing write trace", (value) => value.toolCalls.pop()],
      ["extra trace", (value) => value.toolCalls.push(structuredClone(value.toolCalls[2]!))],
      ["reordered traces", (value) => value.toolCalls.reverse()],
      ["trace sequence", (value) => (value.toolCalls[1]!.sequence = 1)],
      ["list call id", (value) => (value.toolCalls[0]!.toolCallId = "wrong")],
      ["read call id", (value) => (value.toolCalls[1]!.toolCallId = "wrong")],
      ["write call id", (value) => (value.toolCalls[2]!.toolCallId = "wrong")],
      ["read actor", (value) => (value.toolCalls[1]!.threadId = "child")],
      ["read child", (value) => (value.toolCalls[1]!.childThreadId = "child")],
      ["list capability", (value) => (value.toolCalls[0]!.capability = "read")],
      ["write capability", (value) => (value.toolCalls[2]!.capability = "execute")],
      ["read outcome", (value) => (value.toolCalls[1]!.outcome = "runtime_error")],
      ["list input server", (value) => (value.toolCalls[0]!.input = { server: "wrong" })],
      ["read server", (value) => ((value.toolCalls[1]!.input as Record<string, unknown>).server = "wrong")],
      ["read wrong URI", (value) => ((value.toolCalls[1]!.input as Record<string, unknown>).uri = "fixture://wrong")],
      [
        "decoy read",
        (value) => ((value.toolCalls[1]!.input as Record<string, unknown>).uri = value.world.resourceUris[1]),
      ],
      ["read input extra", (value) => ((value.toolCalls[1]!.input as Record<string, unknown>).extra = true)],
      ["list output omission", (value) => mutateList(value, (items) => items.pop())],
      ["list output extra", (value) => mutateList(value, (items) => items.push(structuredClone(items[0])))],
      ["list output reorder", (value) => mutateList(value, (items) => items.reverse())],
      [
        "list output server",
        (value) => mutateList(value, (items) => ((items[0] as Record<string, unknown>).server = "wrong")),
      ],
      [
        "list output URI",
        (value) => mutateList(value, (items) => ((items[0] as Record<string, unknown>).uri = "wrong")),
      ],
      [
        "list output name",
        (value) => mutateList(value, (items) => ((items[0] as Record<string, unknown>).name = "wrong")),
      ],
      [
        "list output description",
        (value) => mutateList(value, (items) => ((items[0] as Record<string, unknown>).description = "wrong")),
      ],
      [
        "list output mime",
        (value) => mutateList(value, (items) => ((items[0] as Record<string, unknown>).mimeType = "application/json")),
      ],
      ["read fact", (value) => ((value.toolCalls[1]!.output as Record<string, unknown>).output = "wrong")],
      ["read metadata server", (value) => (traceMetadata(value, 1).mcpServer = "wrong")],
      ["read metadata URI", (value) => (traceMetadata(value, 1).mcpResource = "wrong")],
      ["write path", (value) => ((value.toolCalls[2]!.input as { patch: string }).patch = expectedWrongPatch(value))],
      [
        "write envelope corruption",
        (value) =>
          ((value.toolCalls[2]!.input as { patch: string }).patch =
            `${(value.toolCalls[2]!.input as { patch: string }).patch}x`),
      ],
      ["write output", (value) => ((value.toolCalls[2]!.output as Record<string, unknown>).output = "wrong")],
      ["write output images", (value) => ((value.toolCalls[2]!.output as Record<string, unknown>).outputImages = [])],
      [
        "write render",
        (value) =>
          ((value.toolCalls[2]!.output as { render: { outputSummary: string } }).render.outputSummary = "wrong"),
      ],
      ["approval omission", (value) => value.approvals.pop()],
      ["approval duplicate", (value) => value.approvals.push(structuredClone(value.approvals[0]!))],
      ["approval method", (value) => ((value.approvals[0] as Record<string, unknown>).method = "userInput/request")],
      ["approval thread", (value) => (approvalParams(value).threadId = "wrong")],
      ["approval permission", (value) => (approvalRequest(value).permission = "read")],
      ["approval tool", (value) => (approvalRequest(value).toolName = "mcp_list_resources")],
      ["approval description", (value) => (approvalRequest(value).description = "wrong")],
      ["approval server", (value) => (approvalDetails(value).server = "wrong")],
      ["approval URI", (value) => (approvalDetails(value).uri = value.world.resourceUris[1])],
      ["runtime server name", (value) => (value.world.runtimeConfigs[0]!.serverNames = ["wrong"])],
      ["runtime command", (value) => (value.world.runtimeConfigs[0]!.command = "node")],
      ["runtime args", (value) => (value.world.runtimeConfigs[0]!.args = ["$WORKSPACE/other.js"])],
      ["runtime cwd", (value) => (value.world.runtimeConfigs[0]!.cwd = "$WORKSPACE/subdir")],
      ["runtime transport", (value) => (value.world.runtimeConfigs[0]!.type = "http")],
      ["runtime resources", (value) => (value.world.runtimeConfigs[0]!.resources = false)],
      ["runtime prompts", (value) => (value.world.runtimeConfigs[0]!.prompts = true)],
      ["entry path", (value) => (value.world.entryPath = "$WORKSPACE/other.js")],
      ["entry content", (value) => (value.world.entryContent += " ")],
      ["entry hash", (value) => (value.world.entryHash = "wrong")],
      ["package content", (value) => (value.world.packageContent += " ")],
      ["package hash", (value) => (value.world.packageHash = "wrong")],
      ["manifest content", (value) => (value.world.manifestContent += " ")],
      ["manifest hash", (value) => (value.world.manifestHash = "wrong")],
      ["entry initial hash", (value) => (workspaceEntry(value, "mcp/server.js", "initial").sha256 = "wrong")],
      ["entry final hash", (value) => (workspaceEntry(value, "mcp/server.js", "final").sha256 = "wrong")],
      ["package final hash", (value) => (workspaceEntry(value, "package.json", "final").sha256 = "wrong")],
      ["artifact omission", (value) => removeWorkspaceEntry(value, "grounded-answer.txt")],
      ["artifact bytes", (value) => (workspaceEntry(value, "grounded-answer.txt", "final").size += 1)],
      ["artifact hash", (value) => (workspaceEntry(value, "grounded-answer.txt", "final").sha256 = "wrong")],
      ["close marker initial", (value) => addWorkspaceEntry(value, ".mcp-closed", "initial")],
      ["close marker final", (value) => addWorkspaceEntry(value, ".mcp-closed", "final")],
      ["unexpected marker", (value) => addWorkspaceEntry(value, ".mcp-unexpected-access", "final")],
      ["extra project file", (value) => addWorkspaceEntry(value, "unexpected.txt", "final")],
      ["verifier omission", (value) => (value.verifier = undefined)],
      ["verifier exit", (value) => (value.verifier!.exitCode = 1)],
      ["verifier timeout", (value) => (value.verifier!.timedOut = true)],
      ["verifier argv", (value) => value.verifier!.argv.push("extra")],
      ["verifier stdout", (value) => (value.verifier!.stdout = "wrong")],
      ["forbidden state", (value) => value.runtimeState.diff.push({ path: "x", category: "other", change: "added" })],
      ["tool output file", (value) => value.toolOutputFiles.push({ path: "x", bytes: 1, sha256: "x" })],
      ["compaction", (value) => value.compactions.push({} as never)],
      ["protocol action", (value) => value.protocolActions.push({} as never)],
      ["user input", (value) => value.userInputRequests.push({})],
      ["child", (value) => value.childSessions.push({ threadId: "child", lines: [] })],
      ["log", (value) => value.logs.push({ level: "error", message: "unexpected" } as never)],
      ["decoy log", (value) => value.logs.push({ level: "info", message: value.world.decoyFacts[0]! } as never)],
      ["turn message omission", (value) => value.turns[0]!.messages.pop()],
      ["turn message reorder", (value) => value.turns[0]!.messages.reverse()],
      ["session omission", (value) => value.session.lines.pop()],
      ["session reorder", (value) => value.session.lines.reverse()],
      ["session linkage", (value) => (value.session.threadId = "wrong")],
      ["thread omission", (value) => value.threadReads[0]!.response.items.pop()],
      ["thread reorder", (value) => value.threadReads[0]!.response.items.reverse()],
      ["thread read metadata", mutateThreadReadMetadata],
      ["thread write render", mutateThreadWriteRender],
      ["lifecycle omission", (value) => value.turns[0]!.coreEvents.splice(13, 1)],
      ["lifecycle reorder", (value) => value.turns[0]!.coreEvents.reverse()],
      ["runtime lifecycle", (value) => value.turns[0]!.runtimeEvents.pop()],
      ["coupled lifecycle write render", mutateCoupledLifecycleWriteRender],
      ["coupled lifecycle final", mutateCoupledLifecycleFinal],
      ["notification omission", (value) => value.turns[0]!.notifications.pop()],
      ["notification extra", addNotification],
      ["resolution id", mutateResolutionId],
      ["coupled fact", (value) => replaceDeep(value, (candidate) => candidate === value.world.fact, "COUPLED_WRONG")],
      [
        "coupled URI",
        (value) =>
          replaceDeep(value, (candidate) => candidate === value.world.intendedUri, value.world.resourceUris[1]),
      ],
      ["final prose", (value) => setFinal(value, "GROUNDING_COMPLETE done")],
      ["final fact", (value) => setFinal(value, value.world.fact)],
      ["final decoy", (value) => setFinal(value, value.world.decoyFacts[0]!)],
      ["final block extra", addFinalBlockField],
      ["coupled persisted output images", addCoupledPersistedOutputImages],
    ];
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      mutate(changed);
      const result = mcpResourceGroundingTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
    expect(mcpResourceGroundingTask.evaluate(structuredClone(baseline))).toEqual({ passed: true });
  });

  test("rejects exact Anthropic edit render mutations", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "anthropic")!;
    const baseline = await assembledExecution(profile);
    const cases: Array<[string, (output: Record<string, unknown>) => void]> = [
      ["input summary", (output) => (editRender(output).inputSummary = "wrong")],
      ["output summary", (output) => (editRender(output).outputSummary = "wrong")],
      ["block output", (output) => (editBlock(output).output = "wrong")],
      ["file path", (output) => (editFile(output).filePath = "wrong")],
      ["action", (output) => (editFile(output).action = "Update")],
      ["hunk", (output) => (editHunk(output).newString = "wrong")],
      ["extra render field", (output) => (editRender(output).unexpected = true)],
      ["output images", (output) => (output.outputImages = [])],
    ];
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      mutate(changed.toolCalls[2]!.output as Record<string, unknown>);
      const result = mcpResourceGroundingTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
  });
});

interface AssembledExecutionOptions {
  includeProgressText?: boolean;
  scopeResourceList?: boolean;
  trailingPatchNewline?: boolean;
}

async function assembledExecution(
  profile: EvalProfile,
  assembledOptions: AssembledExecutionOptions = {},
): Promise<RuntimeEvalExecution<McpResourceGroundingWorld>> {
  const seed = "shared-seed-123";
  let call = 0;
  const result = await runRuntimeEvalExecution({
    task: mcpResourceGroundingTask,
    seed,
    profile,
    streamFunction(model, context, options) {
      call += 1;
      const intendedUri = uriFor(seed, "PRIMARY_REFERENCE");
      const fact = token(seed, "GROUNDED_FACT");
      const response =
        call === 1
          ? assistantMessage(
              [
                ...(assembledOptions.includeProgressText
                  ? [{ type: "text" as const, text: "I will inspect resources." }]
                  : []),
                {
                  type: "tool_call",
                  id: "resource-list-call-1",
                  name: "mcp_list_resources",
                  input: assembledOptions.scopeResourceList ? { server: "fixture-reference" } : {},
                },
              ],
              "tool_use",
            )
          : call === 2
            ? assistantMessage(
                [
                  {
                    type: "tool_call",
                    id: "resource-read-call-2",
                    name: "mcp_read_resource",
                    input: { server: "fixture-reference", uri: intendedUri },
                  },
                ],
                "tool_use",
              )
            : call === 3
              ? assistantMessage(
                  [
                    ...(assembledOptions.includeProgressText
                      ? [{ type: "text" as const, text: "I will write the grounded fact." }]
                      : []),
                    {
                      type: "tool_call",
                      id: "resource-write-call-3",
                      name: profile.provider === "anthropic" ? "edit" : "apply_patch",
                      input:
                        profile.provider === "anthropic"
                          ? {
                              file_path: join(cwdFromContext(context), "grounded-answer.txt"),
                              old_string: "",
                              new_string: `${fact}\n`,
                              replace_all: false,
                            }
                          : {
                              patch: `*** Begin Patch\n*** Add File: grounded-answer.txt\n+${fact}\n*** End Patch${assembledOptions.trailingPatchNewline ? "\n" : ""}`,
                            },
                    },
                  ],
                  "tool_use",
                )
              : assistantMessage([{ type: "text", text: "GROUNDING_COMPLETE" }]);
      return sequenceStream([response])(model, context, options);
    },
  });
  if (
    !assembledOptions.includeProgressText &&
    !assembledOptions.scopeResourceList &&
    !assembledOptions.trailingPatchNewline
  ) {
    expect(
      result.failures,
      JSON.stringify({
        failures: result.failures,
        profile: result.execution.profile,
        toolCalls: result.execution.toolCalls,
      }),
    ).toEqual([]);
  }
  return result.execution as RuntimeEvalExecution<McpResourceGroundingWorld>;
}

function token(seed: string, prefix: string): string {
  return `${prefix}_${seed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "seed"}`;
}

function uriFor(seed: string, prefix: string): string {
  return `fixture://reference/${token(seed, prefix).toLowerCase()}`;
}

function cwdFromContext(context: StreamContext): string {
  const base = context.systemPrompt.find((section) => section.label === "base")?.content ?? "";
  const match = base.match(/^Current working directory: (.+)$/m);
  if (!match?.[1]) throw new Error("Missing runtime cwd in provider context.");
  return match[1];
}

function removeAdvertised(value: RuntimeEvalExecution<McpResourceGroundingWorld>, name: string) {
  value.advertisedTools[0]!.tools = value.advertisedTools[0]!.tools.filter((tool) => tool !== name);
}

function reorderAdvertised(value: RuntimeEvalExecution<McpResourceGroundingWorld>) {
  const tools = value.advertisedTools[0]!.tools;
  const list = tools.indexOf("mcp_list_resources");
  const read = tools.indexOf("mcp_read_resource");
  [tools[list], tools[read]] = [tools[read]!, tools[list]!];
}

function definition(value: RuntimeEvalExecution<McpResourceGroundingWorld>, index: number, call = 0) {
  return value.providerCalls[call]!.tools.items[index] as unknown as Record<string, unknown>;
}

function schemaProperties(value: Record<string, unknown>): Record<string, unknown> {
  return (value.inputSchema as { properties: Record<string, unknown> }).properties;
}

function mutateList(value: RuntimeEvalExecution<McpResourceGroundingWorld>, mutate: (items: unknown[]) => void) {
  const output = value.toolCalls[0]!.output as { output: string };
  const items = JSON.parse(output.output) as unknown[];
  mutate(items);
  output.output = JSON.stringify(items, null, 2);
}

function traceMetadata(value: RuntimeEvalExecution<McpResourceGroundingWorld>, index: number) {
  return (value.toolCalls[index]!.output as { metadata: Record<string, unknown> }).metadata;
}

function expectedWrongPatch(value: RuntimeEvalExecution<McpResourceGroundingWorld>): string {
  return `*** Begin Patch\n*** Add File: wrong.txt\n+${value.world.fact}\n*** End Patch`;
}

function approvalParams(value: RuntimeEvalExecution<McpResourceGroundingWorld>) {
  return (value.approvals[0] as { params: Record<string, unknown> }).params;
}

function approvalRequest(value: RuntimeEvalExecution<McpResourceGroundingWorld>) {
  return approvalParams(value).request as Record<string, unknown>;
}

function approvalDetails(value: RuntimeEvalExecution<McpResourceGroundingWorld>) {
  return approvalRequest(value).details as Record<string, unknown>;
}

function workspaceEntry(
  value: RuntimeEvalExecution<McpResourceGroundingWorld>,
  path: string,
  phase: "initial" | "final",
) {
  return value.workspace[phase].entries.find((entry) => entry.path === path)!;
}

function removeWorkspaceEntry(value: RuntimeEvalExecution<McpResourceGroundingWorld>, path: string) {
  value.workspace.final.entries = value.workspace.final.entries.filter((entry) => entry.path !== path);
}

function addWorkspaceEntry(
  value: RuntimeEvalExecution<McpResourceGroundingWorld>,
  path: string,
  phase: "initial" | "final",
) {
  value.workspace[phase].entries.push({ path, kind: "file", size: 1, sha256: "wrong", executable: false });
}

function addNotification(value: RuntimeEvalExecution<McpResourceGroundingWorld>) {
  value.turns[0]!.notifications.splice(-1, 0, {
    method: "thread/status/changed",
    params: { threadId: value.session.threadId, status: "idle" },
  } as never);
}

function mutateResolutionId(value: RuntimeEvalExecution<McpResourceGroundingWorld>) {
  const notice = value.turns[0]!.notifications.find((item) => item.method === "server/request/resolved")!;
  (notice.params as { requestId: number }).requestId = 2;
}

function replaceDeep(value: unknown, matches: (value: unknown) => boolean, replacement: unknown): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (matches(value[index])) value[index] = replacement;
      else replaceDeep(value[index], matches, replacement);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (matches(child)) (value as Record<string, unknown>)[key] = replacement;
    else replaceDeep(child, matches, replacement);
  }
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

function setFinal(value: RuntimeEvalExecution<McpResourceGroundingWorld>, text: string) {
  const final = value.turns[0]!.messages[7] as { content: Array<{ type: string; text: string }> };
  final.content = [{ type: "text", text }];
}

function addFinalBlockField(value: RuntimeEvalExecution<McpResourceGroundingWorld>) {
  const final = value.turns[0]!.messages[7] as { content: Array<Record<string, unknown>> };
  final.content[0]!.extra = true;
}

function mutateThreadReadMetadata(value: RuntimeEvalExecution<McpResourceGroundingWorld>) {
  const item = value.threadReads[0]!.response.items[6] as unknown as { metadata: Record<string, unknown> };
  item.metadata.mcpResource = "wrong";
}

function mutateThreadWriteRender(value: RuntimeEvalExecution<McpResourceGroundingWorld>) {
  const item = value.threadReads[0]!.response.items[9] as unknown as { render: Record<string, unknown> };
  item.render.outputSummary = "wrong";
}

function mutateCoupledLifecycleWriteRender(value: RuntimeEvalExecution<McpResourceGroundingWorld>) {
  mutateCoupledLifecycleEvent(value, (event) => {
    if (event.type !== "tool_end" || event.toolCallId !== "resource-write-call-3") return;
    (event.render as Record<string, unknown>).outputSummary = "wrong";
  });
}

function mutateCoupledLifecycleFinal(value: RuntimeEvalExecution<McpResourceGroundingWorld>) {
  mutateCoupledLifecycleEvent(value, (event) => {
    if (event.type !== "message_end" || !isFinalMessageRecord(event.message)) return;
    const content = (event.message as { content: Array<Record<string, unknown>> }).content;
    content[0]!.text = "wrong";
  });
}

function mutateCoupledLifecycleEvent(
  value: RuntimeEvalExecution<McpResourceGroundingWorld>,
  mutate: (event: Record<string, unknown>) => void,
) {
  const turn = value.turns[0]!;
  for (const item of turn.coreEvents) mutate(item.event as unknown as Record<string, unknown>);
  for (const event of turn.runtimeEvents) mutate(event as unknown as Record<string, unknown>);
  for (const notice of turn.notifications) {
    if (notice.method !== "agent/event") continue;
    const params = notice.params as unknown as { event?: Record<string, unknown> };
    if (params.event) mutate(params.event);
  }
}

function isFinalMessageRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const content = (value as { content?: unknown }).content;
  return (
    Array.isArray(content) &&
    content.length === 1 &&
    typeof content[0] === "object" &&
    content[0] !== null &&
    (content[0] as { text?: unknown }).text === "GROUNDING_COMPLETE"
  );
}

function addCoupledPersistedOutputImages(value: RuntimeEvalExecution<McpResourceGroundingWorld>) {
  for (const call of value.providerCalls) addOutputImagesToToolResults(call.messages.items);
  addOutputImagesToToolResults(value.turns[0]!.messages);
  for (const line of value.session.lines) {
    const candidate = line as unknown as { type?: string; message?: Record<string, unknown> };
    if (candidate.type === "message" && candidate.message?.role === "tool_result") candidate.message.outputImages = [];
  }
  for (const item of value.threadReads[0]!.response.items) {
    const candidate = item as unknown as Record<string, unknown>;
    if (candidate.type === "toolCall" && candidate.output !== undefined) candidate.outputImages = [];
  }
}

function addOutputImagesToToolResults(items: unknown[]) {
  for (const item of items) {
    const candidate = item as Record<string, unknown>;
    if (candidate.role === "tool_result") candidate.outputImages = [];
  }
}

function editRender(output: Record<string, unknown>): Record<string, unknown> {
  return output.render as Record<string, unknown>;
}

function editBlock(output: Record<string, unknown>): Record<string, unknown> {
  return (editRender(output).blocks as Array<Record<string, unknown>>)[0]!;
}

function editFile(output: Record<string, unknown>): Record<string, unknown> {
  return (editBlock(output).files as Array<Record<string, unknown>>)[0]!;
}

function editHunk(output: Record<string, unknown>): Record<string, unknown> {
  return (editFile(output).hunks as Array<Record<string, unknown>>)[0]!;
}
