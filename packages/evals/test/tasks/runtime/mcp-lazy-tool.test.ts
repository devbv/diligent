// @summary Contract, assembled-runtime execution, and mutation coverage for mcp-lazy-tool

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
import { type McpLazyToolWorld, mcpLazyToolTask } from "../../../src/tasks/runtime/mcp-lazy-tool";
import { assistantMessage, sequenceStream } from "../../helpers/fake-stream";

describe("mcp-lazy-tool", () => {
  test("does not gate MCP routing on persistence or lifecycle mirrors", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!);
    execution.session.lines = [];
    execution.threadReads = [];
    execution.turns[0]!.coreEvents = [];
    execution.turns[0]!.runtimeEvents = [];
    execution.turns[0]!.notifications = [];
    execution.world.runtimeConfigs = [];
    expect(mcpLazyToolTask.evaluate(execution)).toMatchObject({ passed: true });
  });

  test("defines an auto-lazy fixture-local stdio MCP contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-mcp-lazy-"));
    try {
      const world = await mcpLazyToolTask.setup("shared-seed-123", root);
      const config = await mcpLazyToolTask.createRuntimeConfig(world, DEFAULT_PROFILES[0]!);
      expect(mcpLazyToolTask.id).toBe("mcp-lazy-tool");
      expect(mcpLazyToolTask.toolPolicy).toEqual({
        allowedTools: ["mcp_search_tools", "mcp_run_tool"],
        allowedCapabilities: ["execute"],
        allowedCommands: [],
      });
      expect(config.diligent.mcp?.toolLoading).toBe("auto");
      expect(config.diligent.mcp?.lazyThreshold).toBeGreaterThan(0);
      expect(Object.keys(config.diligent.mcpServers ?? {})).toHaveLength(1);
      expect(config.diligent.mcp).toEqual({
        toolLoading: "auto",
        lazyThreshold: 3,
        maxOutputTokens: 1_337,
        resources: false,
        prompts: false,
      });
      expect(config.diligent.mcpServers).toEqual({
        "fixture-logistics": {
          type: "stdio",
          command: process.execPath,
          args: [world.entryPath],
          cwd: root,
          startupTimeoutMs: 5_000,
          toolTimeoutMs: 5_000,
        },
      });
      expect(mcpLazyToolTask.limits).toMatchObject({
        maxTurns: 4,
        maxToolCalls: 4,
        maxChangedFiles: 0,
        maxChangedBytes: 0,
        maxUserInputRequests: 0,
        maxChildAgents: 0,
      });
      expect(mcpLazyToolTask.createSteps(world)).toEqual([
        { kind: "turn", mode: "default", message: world.clientPrompt },
      ]);
      expect(world.clientPrompt).not.toContain(world.receipt);
      expect(world.clientPrompt).not.toContain(world.decoyReceipt);
      expect(world.clientPrompt).not.toMatch(
        /mcp_search_tools|mcp_run_tool|coordinate_sterile_field_unit|coordinate_specimen_archive|case_ref|operating_window|isolation_grade|cold_chain/,
      );
      expect(world.entryPath.startsWith(`${root}/`)).toBe(true);
      expect(world.closeMarkerPath.startsWith(`${root}/`)).toBe(true);
      expect(world.entryContent).toContain("StdioServerTransport");
      expect(world.entryContent).toContain('process.on("exit"');
      expect(world.entryContent).toContain("REJECTED_INPUT");
      expect(world.entryContent).toContain('"anthropic/maxResultSizeChars": 5348');
      const approval = await mcpLazyToolTask.respondToServerRequest?.(world, {
        method: "approval/request",
        params: {
          threadId: "thread-1",
          request: {
            permission: "execute",
            toolName: "mcp_run_tool",
            description: 'Call MCP tool "coordinate_sterile_field_unit" on server "fixture-logistics"',
            details: { server: "fixture-logistics", tool: "coordinate_sterile_field_unit", args: world.request },
          },
        },
      });
      expect(approval).toEqual({ method: "approval/request", result: { decision: "once" } });
      expect(() =>
        mcpLazyToolTask.respondToServerRequest?.(world, {
          method: "userInput/request",
          params: { threadId: "thread-1", request: { questions: [] } },
        }),
      ).toThrow("Unexpected server request");
      expect(world.allowedChanges).toEqual([]);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("runs auto-lazy discovery and approved stdio execution for both default profiles", async () => {
    expect(DEFAULT_PROFILES).toHaveLength(2);
    for (const profile of DEFAULT_PROFILES) {
      const execution = await assembledExecution(profile);
      expect(mcpLazyToolTask.evaluate(execution), profile.provider).toEqual({ passed: true });
      expect(execution.toolCalls.map((call) => call.name)).toEqual(["mcp_search_tools", "mcp_run_tool"]);
      expect(execution.approvals).toHaveLength(1);
      expect(finalText(execution)).toBe(execution.world.receipt);
    }
  });

  test("accepts dynamic call ids, a bounded successful search query, and provider-native non-tool blocks", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!, true);
    const surfaces: unknown[] = [
      execution.toolCalls,
      execution.providerCalls,
      execution.turns,
      execution.session,
      execution.threadReads,
    ];
    for (const surface of surfaces) {
      replaceDeep(surface, (candidate) => candidate === "mcp-search-call-1", "dynamic-search-call");
      replaceDeep(surface, (candidate) => candidate === "mcp-run-call-2", "dynamic-run-call");
      replaceDeep(surface, (candidate) => candidate === "sterile expedition rendezvous", "mobile clinical unit");
    }

    expect(mcpLazyToolTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("accepts an unscoped search when it uniquely returns the exact server tool", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!, false, true);

    expect(mcpLazyToolTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("accepts bounded additional safe searches and rejects a wrong search", async () => {
    const executions: RuntimeEvalExecution<McpLazyToolWorld>[] = [];
    for (const profile of DEFAULT_PROFILES) {
      const execution = await assembledExecution(profile, false, false, true);
      executions.push(execution);
      expect(mcpLazyToolTask.evaluate(execution)).toMatchObject({ passed: true });
    }

    const execution = executions[0]!;
    const wrong = structuredClone(execution);
    (wrong.toolCalls[1]!.input as { query: string }).query = "unrelated archive";
    expect(mcpLazyToolTask.evaluate(wrong).passed).toBe(false);

    const extra = structuredClone(execution);
    extra.toolCalls.splice(2, 0, structuredClone(extra.toolCalls[1]!));
    extra.toolCalls[2]!.toolCallId = "third-safe-search";
    extra.toolCalls.forEach((call, index) => (call.sequence = index + 1));
    expect(mcpLazyToolTask.evaluate(extra)).toMatchObject({
      passed: true,
      diagnostics: [{ code: "mcp_lazy.second_safe_search" }],
    });
  });

  test("rejects the independent lazy routing, schema, approval, config, cleanup, persistence, and isolation mutation matrix", async () => {
    const baseline = await assembledExecution(DEFAULT_PROFILES[0]!);
    expect(mcpLazyToolTask.evaluate(baseline)).toEqual({ passed: true });
    const cases: Array<[string, (value: RuntimeEvalExecution<McpLazyToolWorld>) => void]> = [
      ["task id", (value) => (value.taskId = "other")],
      ["seed linkage", (value) => (value.world.seed = "wrong")],
      ["world request", (value) => (value.world.request.case_ref = "wrong")],
      ["world receipt", (value) => (value.world.receipt = "wrong")],
      ["prompt proxy leak", (value) => (value.turns[0]!.clientPrompt += " mcp_run_tool")],
      ["prompt raw leak", (value) => (value.turns[0]!.clientPrompt += " coordinate_sterile_field_unit")],
      ["prompt receipt leak", (value) => (value.turns[0]!.clientPrompt += ` ${value.world.receipt}`)],
      ["termination", (value) => (value.termination = "runtime_error")],
      ["execution error", (value) => (value.error = { name: "Error", message: "unexpected" })],
      ["profile model", (value) => (value.profile.model = "wrong")],
      ["profile effort", (value) => (value.profile.effort = "low" as never)],
      ["extra turn", (value) => value.turns.push(structuredClone(value.turns[0]!))],
      ["thread cwd", (value) => (value.threadCwd = "$WORKSPACE/subdir")],
      ["thread current model", (value) => (value.threadReads[0]!.response.currentModel!.modelId = "wrong")],
      ["thread current effort", (value) => (value.threadReads[0]!.response.currentEffort = "low")],
      ["advertised mode", (value) => (value.advertisedTools[0]!.mode = "plan")],
      ["missing search advertisement", (value) => removeAdvertised(value, "mcp_search_tools")],
      ["missing run advertisement", (value) => removeAdvertised(value, "mcp_run_tool")],
      ["reordered advertisements", reorderAdvertised],
      ["duplicate advertisement", (value) => value.advertisedTools[0]!.tools.push("mcp_run_tool")],
      [
        "eager advertisement",
        (value) => value.advertisedTools[0]!.tools.push("mcp__fixture-logistics__coordinate_sterile_field_unit"),
      ],
      [
        "extra advertisement snapshot",
        (value) => value.advertisedTools.push(structuredClone(value.advertisedTools[0]!)),
      ],
      ["missing provider call", (value) => value.providerCalls.pop()],
      ["extra provider call", (value) => value.providerCalls.push(structuredClone(value.providerCalls[2]!))],
      ["reordered provider calls", (value) => value.providerCalls.reverse()],
      ["provider sequence", (value) => (value.providerCalls[1]!.sequence = 1)],
      ["provider model", (value) => (value.providerCalls[1]!.model.modelId = "wrong")],
      ["provider effort", (value) => (value.providerCalls[1]!.streamOptions.effort = "wrong")],
      ["provider session", (value) => (value.providerCalls[1]!.sessionId = "wrong")],
      ["provider stream session", (value) => (value.providerCalls[1]!.streamOptions.sessionId = "wrong")],
      ["provider max tokens", (value) => (value.providerCalls[1]!.streamOptions.maxTokens = 1)],
      ["provider bounds", (value) => (value.providerCalls[1]!.bounds.omittedNestedItems += 1)],
      ["provider message omission", (value) => value.providerCalls[2]!.messages.items.pop()],
      ["provider message extra", (value) => value.providerCalls[1]!.messages.items.push({})],
      ["provider message reorder", (value) => value.providerCalls[2]!.messages.items.reverse()],
      ["missing provider definition", (value) => value.providerCalls[0]!.tools.items.pop()],
      ["extra provider definition", (value) => value.providerCalls[0]!.tools.items.push({} as never)],
      ["reordered definitions", (value) => value.providerCalls[0]!.tools.items.reverse()],
      ["duplicated definition", duplicateDefinition],
      ["search description", (value) => (definition(value, 0).description = "wrong")],
      ["run description", (value) => (definition(value, 1).description = "wrong")],
      ["search proxy schema", mutateSearchProxySchema],
      ["run proxy schema", mutateRunProxySchema],
      ["later definition divergence", (value) => (definition(value, 1, 1).description = "wrong")],
      ["missing search trace", (value) => value.toolCalls.shift()],
      ["missing run trace", (value) => value.toolCalls.pop()],
      ["extra trace", (value) => value.toolCalls.push(structuredClone(value.toolCalls[1]!))],
      ["reordered traces", (value) => value.toolCalls.reverse()],
      ["duplicated search trace", (value) => (value.toolCalls[1] = structuredClone(value.toolCalls[0]!))],
      ["run before search", runBeforeSearch],
      ["search call id", (value) => (value.toolCalls[0]!.toolCallId = "wrong")],
      ["run call id", (value) => (value.toolCalls[1]!.toolCallId = "wrong")],
      ["search actor", (value) => (value.toolCalls[0]!.threadId = "child")],
      ["run actor", (value) => (value.toolCalls[1]!.threadId = "child")],
      ["search capability", (value) => (value.toolCalls[0]!.capability = "read")],
      ["run outcome", (value) => (value.toolCalls[1]!.outcome = "runtime_error")],
      ["search query", (value) => ((value.toolCalls[0]!.input as Record<string, unknown>).query = "wrong")],
      ["search server", (value) => ((value.toolCalls[0]!.input as Record<string, unknown>).server = "wrong")],
      ["search input extra", (value) => ((value.toolCalls[0]!.input as Record<string, unknown>).extra = true)],
      ["run server", (value) => ((value.toolCalls[1]!.input as Record<string, unknown>).server = "wrong")],
      [
        "run raw tool",
        (value) => ((value.toolCalls[1]!.input as Record<string, unknown>).tool = "coordinate_specimen_archive"),
      ],
      ["run args omitted", removeRunArgs],
      ["run args extra", (value) => (runArgs(value).extra = true)],
      ["run nested omission", (value) => delete (runArgs(value).deployment as Record<string, unknown>).location],
      ["run nested type", (value) => ((runArgs(value).support as Record<string, unknown>).cold_chain = "true")],
      [
        "run nested value",
        (value) => ((runArgs(value).support as Record<string, unknown>).isolation_grade = "standard"),
      ],
      ["run array reorder", (value) => team(value).reverse()],
      ["run array omission", (value) => team(value).pop()],
      ["run array duplicate", (value) => (team(value)[1] = structuredClone(team(value)[0]))],
      ["search output", (value) => ((value.toolCalls[0]!.output as Record<string, unknown>).output = "wrong")],
      ["search schema mutation", mutateSearchResultSchema],
      ["search extra result", addSearchResult],
      ["run receipt", (value) => ((value.toolCalls[1]!.output as Record<string, unknown>).output = "wrong")],
      ["run metadata server", (value) => (runMetadata(value).mcpServer = "wrong")],
      ["run metadata tool", (value) => (runMetadata(value).mcpTool = "wrong")],
      ["run metadata error", (value) => (runMetadata(value).isError = true)],
      ["run output cap", (value) => ((value.toolCalls[1]!.output as Record<string, unknown>).maxOutputBytes = 1)],
      ["run output extra", (value) => ((value.toolCalls[1]!.output as Record<string, unknown>).extra = true)],
      ["approval omission", (value) => value.approvals.pop()],
      ["approval duplicate", (value) => value.approvals.push(structuredClone(value.approvals[0]!))],
      ["approval method", (value) => ((value.approvals[0] as Record<string, unknown>).method = "userInput/request")],
      ["approval thread", mutateApprovalThread],
      ["approval permission", (value) => (approvalRequest(value).permission = "read")],
      ["approval proxy", (value) => (approvalRequest(value).toolName = "mcp__direct")],
      ["approval description", (value) => (approvalRequest(value).description = "wrong")],
      ["approval details server", (value) => (approvalDetails(value).server = "wrong")],
      ["approval details tool", (value) => (approvalDetails(value).tool = "wrong")],
      ["approval details args", (value) => (approvalDetails(value).args = {})],
      ["runtime server name", (value) => (value.world.runtimeConfigs[0]!.serverNames = ["wrong"])],
      ["runtime command", (value) => (value.world.runtimeConfigs[0]!.command = "node")],
      ["runtime entry args", (value) => (value.world.runtimeConfigs[0]!.args = ["$WORKSPACE/other.js"])],
      ["runtime cwd", (value) => (value.world.runtimeConfigs[0]!.cwd = "$WORKSPACE/subdir")],
      ["runtime transport", (value) => (value.world.runtimeConfigs[0]!.type = "http")],
      ["runtime startup timeout", (value) => (value.world.runtimeConfigs[0]!.startupTimeoutMs = 1)],
      ["runtime tool timeout", (value) => (value.world.runtimeConfigs[0]!.toolTimeoutMs = 1)],
      ["runtime loading", (value) => (value.world.runtimeConfigs[0]!.toolLoading = "lazy")],
      ["runtime threshold", (value) => (value.world.runtimeConfigs[0]!.lazyThreshold = 5)],
      ["runtime resources", (value) => (value.world.runtimeConfigs[0]!.resources = true)],
      ["runtime prompts", (value) => (value.world.runtimeConfigs[0]!.prompts = true)],
      ["entry path", (value) => (value.world.entryPath = "$WORKSPACE/other.js")],
      ["entry content", (value) => (value.world.entryContent += " ")],
      ["entry declared hash", (value) => (value.world.entryHash = "wrong")],
      ["close marker path", (value) => (value.world.closeMarkerPath = "$WORKSPACE/other-marker")],
      ["manifest content", (value) => (value.world.manifestContent += " ")],
      ["manifest hash", (value) => (value.world.manifestHash = "wrong")],
      ["entry initial hash", (value) => (workspaceEntry(value, "mcp/server.js", "initial").sha256 = "wrong")],
      ["entry final hash", (value) => (workspaceEntry(value, "mcp/server.js", "final").sha256 = "wrong")],
      ["close marker initial", addInitialCloseMarker],
      ["close marker final", addFinalCloseMarker],
      ["project mutation", addProjectMutation],
      [
        "runtime knowledge",
        (value) =>
          value.runtimeState.diff.push({ path: ".diligent/knowledge/x", category: "knowledge", change: "added" }),
      ],
      ["runtime other", (value) => value.runtimeState.diff.push({ path: "other", category: "other", change: "added" })],
      ["registered output", (value) => value.toolOutputFiles.push({ path: "x", bytes: 1, sha256: "x" })],
      ["compaction", (value) => value.compactions.push({} as never)],
      ["protocol action", (value) => value.protocolActions.push({} as never)],
      ["user input", (value) => value.userInputRequests.push({})],
      ["child", (value) => value.childSessions.push({ threadId: "child", lines: [] })],
      [
        "verifier",
        (value) => (value.verifier = { argv: [], exitCode: 0, elapsedMs: 0, stdout: "", stderr: "", timedOut: false }),
      ],
      ["error log", (value) => value.logs.push({ level: "error", message: "unexpected" } as never)],
      ["decoy receipt log", (value) => value.logs.push({ level: "info", message: value.world.decoyReceipt } as never)],
      ["turn message omission", (value) => value.turns[0]!.messages.pop()],
      ["turn message reorder", (value) => value.turns[0]!.messages.reverse()],
      ["turn result render", addTurnResultRender],
      ["session omission", (value) => value.session.lines.pop()],
      ["session reorder", (value) => value.session.lines.reverse()],
      ["session linkage", (value) => (value.session.threadId = "wrong")],
      ["thread omission", (value) => value.threadReads[0]!.response.items.pop()],
      ["thread reorder", (value) => value.threadReads[0]!.response.items.reverse()],
      ["thread input", mutateThreadRunInput],
      ["lifecycle omission", (value) => value.turns[0]!.coreEvents.splice(12, 1)],
      ["lifecycle reorder", (value) => value.turns[0]!.coreEvents.reverse()],
      ["runtime lifecycle divergence", (value) => value.turns[0]!.runtimeEvents.pop()],
      ["notification divergence", (value) => value.turns[0]!.notifications.pop()],
      ["notification non-agent extra", addNonAgentNotification],
      ["resolution request id", mutateResolutionRequestId],
      ["coupled lifecycle final", mutateCoupledLifecycleFinal],
      ["coupled search output", mutateCoupledSearchOutput],
      ["coupled run receipt", mutateCoupledRunReceipt],
      ["final prose", (value) => setFinal(value, `${value.world.receipt} complete`)],
      ["final decoy", (value) => setFinal(value, value.world.decoyReceipt)],
      ["final block extra", addFinalBlockField],
    ];
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      mutate(changed);
      const result = mcpLazyToolTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
    expect(mcpLazyToolTask.evaluate(structuredClone(baseline))).toEqual({ passed: true });
  });
});

async function assembledExecution(
  profile: EvalProfile,
  includeProgressText = false,
  omitSearchServer = false,
  parallelSearch = false,
): Promise<RuntimeEvalExecution<McpLazyToolWorld>> {
  const seed = "shared-seed-123";
  let call = 0;
  const result = await runRuntimeEvalExecution({
    task: mcpLazyToolTask,
    seed,
    profile,
    streamFunction(model, context, options) {
      call += 1;
      const response =
        call === 1
          ? assistantMessage(
              [
                ...(includeProgressText ? [{ type: "text" as const, text: "Discovering the MCP tool." }] : []),
                {
                  type: "tool_call",
                  id: "mcp-search-call-1",
                  name: "mcp_search_tools",
                  input: {
                    query: "sterile expedition rendezvous",
                    ...(omitSearchServer ? {} : { server: "fixture-logistics" }),
                  },
                },
                ...(parallelSearch
                  ? [
                      {
                        type: "tool_call" as const,
                        id: "mcp-search-call-2",
                        name: "mcp_search_tools",
                        input: { query: "field" },
                      },
                    ]
                  : []),
              ],
              "tool_use",
            )
          : call === 2
            ? assistantMessage(
                [
                  ...(includeProgressText ? [{ type: "text" as const, text: "Running the discovered MCP tool." }] : []),
                  {
                    type: "tool_call",
                    id: "mcp-run-call-2",
                    name: "mcp_run_tool",
                    input: {
                      server: "fixture-logistics",
                      tool: "coordinate_sterile_field_unit",
                      args: requestFor(seed),
                    },
                  },
                ],
                "tool_use",
              )
            : assistantMessage([{ type: "text", text: token(seed, "FIELD_UNIT_RECEIPT") }]);
      return sequenceStream([response])(model, context, options);
    },
  });
  if (!includeProgressText && !omitSearchServer) expect(result.failures, JSON.stringify(result.failures)).toEqual([]);
  expect(result.execution.termination).toBe("completed");
  return result.execution as RuntimeEvalExecution<McpLazyToolWorld>;
}

function requestFor(seed: string) {
  return {
    case_ref: token(seed, "FIELD_CASE"),
    deployment: {
      location: { facility: token(seed, "FACILITY"), region_code: "KR-41" },
      operating_window: { opens: "2026-10-06", closes: "2026-10-09" },
      team: [
        { badge: token(seed, "CLINICIAN"), role: "clinician" },
        { badge: token(seed, "TECHNICIAN"), role: "technician" },
      ],
    },
    support: { isolation_grade: "negative_pressure", cold_chain: true },
  };
}

function token(seed: string, prefix: string): string {
  return `${prefix}_${seed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "seed"}`;
}

function finalText(value: RuntimeEvalExecution<McpLazyToolWorld>): string {
  const final = value.turns[0]!.messages.at(-1) as Message | undefined;
  return final?.role === "assistant" && Array.isArray(final.content)
    ? final.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    : "";
}

function removeAdvertised(value: RuntimeEvalExecution<McpLazyToolWorld>, name: string) {
  value.advertisedTools[0]!.tools = value.advertisedTools[0]!.tools.filter((tool) => tool !== name);
}

function reorderAdvertised(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  const tools = value.advertisedTools[0]!.tools;
  const search = tools.indexOf("mcp_search_tools");
  const run = tools.indexOf("mcp_run_tool");
  [tools[search], tools[run]] = [tools[run]!, tools[search]!];
}

function definition(value: RuntimeEvalExecution<McpLazyToolWorld>, index: number, call = 0): Record<string, unknown> {
  return value.providerCalls[call]!.tools.items[index] as unknown as Record<string, unknown>;
}

function duplicateDefinition(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  value.providerCalls[0]!.tools.items[1] = structuredClone(value.providerCalls[0]!.tools.items[0]!);
}

function mutateSearchProxySchema(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  const schema = definition(value, 0).inputSchema as { properties: Record<string, unknown> };
  delete schema.properties.server;
}

function mutateRunProxySchema(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  const schema = definition(value, 1).inputSchema as Record<string, unknown>;
  schema.additionalProperties = true;
}

function runBeforeSearch(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  value.toolCalls.reverse();
  value.toolCalls[0]!.sequence = 1;
  value.toolCalls[1]!.sequence = 2;
}

function runArgs(value: RuntimeEvalExecution<McpLazyToolWorld>): Record<string, unknown> {
  return (value.toolCalls[1]!.input as { args: Record<string, unknown> }).args;
}

function removeRunArgs(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  delete (value.toolCalls[1]!.input as Record<string, unknown>).args;
}

function team(value: RuntimeEvalExecution<McpLazyToolWorld>): unknown[] {
  return (runArgs(value).deployment as { team: unknown[] }).team;
}

function mutateSearchResultSchema(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  const output = value.toolCalls[0]!.output as { output: string };
  const result = JSON.parse(output.output) as Array<{ inputSchema: { properties: Record<string, unknown> } }>;
  delete result[0]!.inputSchema.properties.support;
  output.output = JSON.stringify(result, null, 2);
}

function addSearchResult(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  const output = value.toolCalls[0]!.output as { output: string };
  const result = JSON.parse(output.output) as unknown[];
  result.push(structuredClone(result[0]!));
  output.output = JSON.stringify(result, null, 2);
}

function runMetadata(value: RuntimeEvalExecution<McpLazyToolWorld>): Record<string, unknown> {
  return (value.toolCalls[1]!.output as { metadata: Record<string, unknown> }).metadata;
}

function approvalParams(value: RuntimeEvalExecution<McpLazyToolWorld>): Record<string, unknown> {
  return (value.approvals[0] as { params: Record<string, unknown> }).params;
}

function approvalRequest(value: RuntimeEvalExecution<McpLazyToolWorld>): Record<string, unknown> {
  return approvalParams(value).request as Record<string, unknown>;
}

function approvalDetails(value: RuntimeEvalExecution<McpLazyToolWorld>): Record<string, unknown> {
  return approvalRequest(value).details as Record<string, unknown>;
}

function mutateApprovalThread(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  approvalParams(value).threadId = "wrong";
}

function workspaceEntry(value: RuntimeEvalExecution<McpLazyToolWorld>, path: string, phase: "initial" | "final") {
  return value.workspace[phase].entries.find((entry) => entry.path === path)!;
}

function addInitialCloseMarker(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  value.workspace.initial.entries.push({ path: ".mcp-closed", kind: "file", size: 7, sha256: "wrong" });
}

function addFinalCloseMarker(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  value.workspace.final.entries.push({ path: ".mcp-closed", kind: "file", size: 7, sha256: "wrong" });
}

function addProjectMutation(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  value.workspace.final.entries.push({ path: "unexpected.txt", kind: "file", size: 1, sha256: "wrong" });
}

function mutateThreadRunInput(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  const item = value.threadReads[0]!.response.items[5] as unknown as { input: Record<string, unknown> };
  item.input.server = "wrong";
}

function addTurnResultRender(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  (value.turns[0]!.messages[2] as Message & Record<string, unknown>).render = {
    inputSummary: "unexpected",
  };
}

function addNonAgentNotification(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  value.turns[0]!.notifications.splice(-1, 0, {
    method: "thread/status/changed",
    params: { threadId: value.session.threadId, status: "idle" },
  } as never);
}

function mutateResolutionRequestId(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  const notice = value.turns[0]!.notifications.find((item) => item.method === "server/request/resolved")!;
  (notice.params as { requestId: number }).requestId = 2;
}

function mutateCoupledLifecycleFinal(value: RuntimeEvalExecution<McpLazyToolWorld>) {
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

function mutateCoupledSearchOutput(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  replaceDeep(value, (candidate) => candidate === (value.toolCalls[0]!.output as { output: string }).output, "[]");
}

function mutateCoupledRunReceipt(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  replaceDeep(value, (candidate) => candidate === value.world.receipt, "COUPLED_WRONG_RECEIPT");
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

function setFinal(value: RuntimeEvalExecution<McpLazyToolWorld>, text: string) {
  const final = value.turns[0]!.messages[5] as { content: Array<{ type: string; text: string }> };
  final.content = [{ type: "text", text }];
}

function addFinalBlockField(value: RuntimeEvalExecution<McpLazyToolWorld>) {
  const final = value.turns[0]!.messages[5] as { content: Array<Record<string, unknown>> };
  final.content[0]!.extra = true;
}
