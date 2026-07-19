// @summary Contract and assembled-runtime coverage for MCP prompt grounding

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
import { type McpPromptGroundingWorld, mcpPromptGroundingTask } from "../../../src/tasks/runtime/mcp-prompt-grounding";
import { assistantMessage, sequenceStream } from "../../helpers/fake-stream";

describe("mcp-prompt-grounding", () => {
  test("defines a fixture-local stdio MCP prompt grounding contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-mcp-prompt-"));
    try {
      const world = await mcpPromptGroundingTask.setup("shared-seed-123", root);
      const config = await mcpPromptGroundingTask.createRuntimeConfig(world, DEFAULT_PROFILES[0]!);
      expect(mcpPromptGroundingTask.id).toBe("mcp-prompt-grounding");
      expect(mcpPromptGroundingTask.toolPolicy).toEqual({
        allowedTools: ["mcp_list_prompts", "mcp_get_prompt", "apply_patch", "edit"],
        allowedCapabilities: ["execute", "write"],
        allowedCommands: [],
      });
      expect(config.diligent.mcp).toEqual({
        toolLoading: "eager",
        lazyThreshold: 10,
        maxOutputTokens: 1_337,
        resources: false,
        prompts: true,
      });
      expect(config.diligent.mcpServers).toEqual({
        "fixture-workflows": {
          type: "stdio",
          command: process.execPath,
          args: [world.entryPath],
          cwd: root,
          startupTimeoutMs: 5_000,
          toolTimeoutMs: 5_000,
        },
      });
      expect(mcpPromptGroundingTask.limits).toMatchObject({
        maxTurns: 5,
        maxToolCalls: 4,
        maxChangedFiles: 1,
        maxChangedBytes: world.expected.length,
        maxUserInputRequests: 0,
        maxChildAgents: 0,
      });
      expect(world.promptNames).toHaveLength(3);
      expect(new Set(world.promptNames).size).toBe(3);
      expect(world.argumentNames).toEqual(["relay_designator", "handoff_window"]);
      expect(world.argumentValues.every((value) => world.clientPrompt.includes(value))).toBe(true);
      expect(world.clientPrompt).not.toContain(world.fact);
      expect(world.promptNames.every((name) => !world.clientPrompt.includes(name))).toBe(true);
      expect(world.decoyFacts.every((fact) => !world.clientPrompt.includes(fact))).toBe(true);
      expect(world.clientPrompt).not.toMatch(/mcp_list_prompts|mcp_get_prompt|apply_patch/);
      expect(world.entryContent).toContain("StdioServerTransport");
      expect(world.entryContent).toContain("registerPrompt");
      expect(world.entryContent).toContain("Archived orbital value:");
      expect(world.entryContent).toContain("Current terrestrial value:");
      expect(world.entryContent).toContain('process.on("exit"');
      expect(world.protectedPaths).toEqual(["mcp/server.js", "package.json", "manifest.json", ".git/.keep"]);
      expect(world.allowedChanges).toEqual(["orbital-workflow.txt"]);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("runs list, intended render, exact write, and final response for both default profiles", async () => {
    expect(DEFAULT_PROFILES).toHaveLength(2);
    for (const profile of DEFAULT_PROFILES) {
      const execution = await assembledExecution(profile);
      expect(mcpPromptGroundingTask.evaluate(execution), profile.provider).toEqual({ passed: true });
      expect(execution.toolCalls.map((call) => call.name)).toEqual([
        "mcp_list_prompts",
        "mcp_get_prompt",
        profile.provider === "anthropic" ? "edit" : "apply_patch",
      ]);
      expect(execution.approvals).toHaveLength(1);
      expect(execution.workspace.final.entries.find((entry) => entry.path === "orbital-workflow.txt")?.sha256).toBe(
        execution.world.expectedHash,
      );
    }
  });

  test("accepts runtime-generated call ids, exact list scope, provider progress blocks, and patch envelope whitespace", async () => {
    const execution = await assembledExecution(DEFAULT_PROFILES[0]!, {
      includeProgressText: true,
      scopePromptList: true,
      trailingPatchNewline: true,
    });
    const ids = ["runtime-list-call", "runtime-get-call", "runtime-write-call"];
    for (const [index, original] of ["prompt-list-call-1", "prompt-get-call-2", "prompt-write-call-3"].entries()) {
      replaceDeep(execution, (candidate) => candidate === original, ids[index]);
    }
    expect(execution.toolCalls[0]!.input).toEqual({ server: "fixture-workflows" });
    expect((execution.toolCalls[2]!.input as { patch: string }).patch.endsWith("*** End Patch\n")).toBe(true);
    expect(execution.turns[0]!.coreEvents.filter((item) => item.event.type === "message_delta").length).toBeGreaterThan(
      1,
    );
    expect(mcpPromptGroundingTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("accepts omission of the provider edit flag when the runtime records its false schema default", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "anthropic")!;
    const execution = await assembledExecution(profile);
    for (const surface of [execution.providerCalls, execution.turns, execution.session, execution.threadReads]) {
      removePersistedEditDefault(surface);
    }
    expect(execution.toolCalls[2]!.input).toMatchObject({ replace_all: false });
    expect(mcpPromptGroundingTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("allows one bounded edit runtime error followed immediately by the exact successful write", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "anthropic")!;
    for (const recoveryKind of ["relative-path", "missing-file"] as const) {
      const execution = await assembledExecution(profile, { recoveryKind });
      expect(execution.termination, recoveryKind).toBe("completed");
      expect(
        execution.toolCalls.map((call) => call.outcome),
        recoveryKind,
      ).toEqual(["success", "success", "runtime_error", "success"]);
      expect(mcpPromptGroundingTask.evaluate(execution), recoveryKind).toMatchObject({ passed: true });
    }
  });

  test("rejects recovery attempts outside the two bounded intended-write runtime errors", async () => {
    const profile = DEFAULT_PROFILES.find((candidate) => candidate.provider === "anthropic")!;
    const baseline = await assembledExecution(profile, { recoveryKind: "relative-path" });
    const cases: Array<[string, (value: RuntimeEvalExecution<McpPromptGroundingWorld>) => void]> = [
      ["outcome", (value) => (value.toolCalls[2]!.outcome = "policy_rejection")],
      ["error", (value) => (value.toolCalls[2]!.error = "wrong")],
      ["path", (value) => ((value.toolCalls[2]!.input as Record<string, unknown>).file_path = "other.txt")],
      ["content", (value) => ((value.toolCalls[2]!.input as Record<string, unknown>).new_string = "wrong")],
      ["output", (value) => ((value.toolCalls[2]!.output as Record<string, unknown>).output = "wrong")],
    ];
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      mutate(changed);
      const result = mcpPromptGroundingTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
  });

  test("rejects the independent prompt, name, approval, artifact, persistence, lifecycle, and isolation mutation matrix", async () => {
    const baseline = await assembledExecution(DEFAULT_PROFILES[0]!);
    expect(mcpPromptGroundingTask.evaluate(baseline)).toEqual({ passed: true });
    const cases: Array<[string, (value: RuntimeEvalExecution<McpPromptGroundingWorld>) => void]> = [
      ["task id", (value) => (value.taskId = "other")],
      ["seed linkage", (value) => (value.world.seed = "wrong")],
      ["world fact", (value) => (value.world.fact = "wrong")],
      ["world intended name", (value) => (value.world.intendedName = value.world.promptNames[1]!)],
      ["world prompts omission", (value) => value.world.prompts.pop()],
      ["world prompts reorder", (value) => value.world.prompts.reverse()],
      ["world argument name", (value) => (value.world.argumentNames[0] = "wrong")],
      ["world argument value", (value) => (value.world.argumentValues[0] = "wrong")],
      ["world decoy fact", (value) => (value.world.decoyFacts[0] = "wrong")],
      ["prompt fact leak", (value) => (value.turns[0]!.clientPrompt += ` ${value.world.fact}`)],
      ["prompt name leak", (value) => (value.turns[0]!.clientPrompt += ` ${value.world.intendedName}`)],
      ["prompt proxy leak", (value) => (value.turns[0]!.clientPrompt += " mcp_get_prompt")],
      ["termination", (value) => (value.termination = "runtime_error")],
      ["execution error", (value) => (value.error = { name: "Error", message: "unexpected" })],
      ["profile model", (value) => (value.profile.model = "wrong")],
      ["profile effort", (value) => (value.profile.effort = "low" as never)],
      ["extra turn", (value) => value.turns.push(structuredClone(value.turns[0]!))],
      ["thread cwd", (value) => (value.threadCwd = "$WORKSPACE/subdir")],
      ["thread model", (value) => (value.threadReads[0]!.response.currentModel!.modelId = "wrong")],
      ["advertised mode", (value) => (value.advertisedTools[0]!.mode = "plan")],
      ["missing list advertisement", (value) => removeAdvertised(value, "mcp_list_prompts")],
      ["missing get advertisement", (value) => removeAdvertised(value, "mcp_get_prompt")],
      ["missing write advertisement", (value) => removeAdvertised(value, "apply_patch")],
      ["reordered advertisements", reorderAdvertised],
      ["duplicate advertisement", (value) => value.advertisedTools[0]!.tools.push("mcp_get_prompt")],
      [
        "extra direct MCP advertisement",
        (value) => value.advertisedTools[0]!.tools.push("mcp__fixture-workflows__unexpected_direct_tool"),
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
      ["get definition", (value) => (definition(value, 2).description = "wrong")],
      ["definition extra field", (value) => (definition(value, 2).unexpected = true)],
      ["list schema", (value) => delete schemaProperties(definition(value, 1)).server],
      ["get schema", (value) => delete schemaProperties(definition(value, 2)).name],
      ["later definition divergence", (value) => (definition(value, 2, 1).description = "wrong")],
      ["missing list trace", (value) => value.toolCalls.shift()],
      ["missing get trace", (value) => value.toolCalls.splice(1, 1)],
      ["missing write trace", (value) => value.toolCalls.pop()],
      ["extra trace", (value) => value.toolCalls.push(structuredClone(value.toolCalls[2]!))],
      ["reordered traces", (value) => value.toolCalls.reverse()],
      ["trace sequence", (value) => (value.toolCalls[1]!.sequence = 1)],
      ["list call id", (value) => (value.toolCalls[0]!.toolCallId = "wrong")],
      ["get call id", (value) => (value.toolCalls[1]!.toolCallId = "wrong")],
      ["write call id", (value) => (value.toolCalls[2]!.toolCallId = "wrong")],
      ["get actor", (value) => (value.toolCalls[1]!.threadId = "child")],
      ["get child", (value) => (value.toolCalls[1]!.childThreadId = "child")],
      ["list capability", (value) => (value.toolCalls[0]!.capability = "read")],
      ["write capability", (value) => (value.toolCalls[2]!.capability = "execute")],
      ["get outcome", (value) => (value.toolCalls[1]!.outcome = "runtime_error")],
      ["list input server", (value) => (value.toolCalls[0]!.input = { server: "wrong" })],
      ["get server", (value) => ((value.toolCalls[1]!.input as Record<string, unknown>).server = "wrong")],
      ["get wrong name", (value) => ((value.toolCalls[1]!.input as Record<string, unknown>).name = "wrong")],
      [
        "decoy get",
        (value) => ((value.toolCalls[1]!.input as Record<string, unknown>).name = value.world.promptNames[1]),
      ],
      ["get input extra", (value) => ((value.toolCalls[1]!.input as Record<string, unknown>).extra = true)],
      ["args missing", (value) => delete (value.toolCalls[1]!.input as Record<string, unknown>).args],
      ["args extra", (value) => (promptArgs(value).unexpected = "wrong")],
      ["args first missing", (value) => delete promptArgs(value)[value.world.argumentNames[0]]],
      ["args second missing", (value) => delete promptArgs(value)[value.world.argumentNames[1]]],
      ["args first wrong", (value) => (promptArgs(value)[value.world.argumentNames[0]] = "wrong")],
      ["args second wrong", (value) => (promptArgs(value)[value.world.argumentNames[1]] = "wrong")],
      ["args first type", (value) => (promptArgs(value)[value.world.argumentNames[0]] = 42)],
      ["args reorder", reorderPromptArgs],
      ["list output omission", (value) => mutateList(value, (items) => items.pop())],
      ["list output extra", (value) => mutateList(value, (items) => items.push(structuredClone(items[0])))],
      ["list output reorder", (value) => mutateList(value, (items) => items.reverse())],
      [
        "list output server",
        (value) => mutateList(value, (items) => ((items[0] as Record<string, unknown>).server = "wrong")),
      ],
      [
        "list arguments omission",
        (value) => mutateList(value, (items) => delete (items[0] as Record<string, unknown>).arguments),
      ],
      ["list arguments extra", (value) => mutateListArgument(value, (args) => args.push(structuredClone(args[0])))],
      ["list arguments reorder", (value) => mutateListArgument(value, (args) => args.reverse())],
      ["list argument name", (value) => mutateListArgumentRecord(value, (arg) => (arg.name = "wrong"))],
      ["list argument description", (value) => mutateListArgumentRecord(value, (arg) => (arg.description = "wrong"))],
      ["list argument required", (value) => mutateListArgumentRecord(value, (arg) => (arg.required = false))],
      [
        "list output name",
        (value) => mutateList(value, (items) => ((items[0] as Record<string, unknown>).name = "wrong")),
      ],
      [
        "list output description",
        (value) => mutateList(value, (items) => ((items[0] as Record<string, unknown>).description = "wrong")),
      ],
      [
        "list output extra field",
        (value) => mutateList(value, (items) => ((items[0] as Record<string, unknown>).mimeType = "application/json")),
      ],
      ["get rendered output", (value) => ((value.toolCalls[1]!.output as Record<string, unknown>).output = "wrong")],
      ["get metadata server", (value) => (traceMetadata(value, 1).mcpServer = "wrong")],
      ["get metadata name", (value) => (traceMetadata(value, 1).mcpPrompt = "wrong")],
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
      ["approval tool", (value) => (approvalRequest(value).toolName = "mcp_list_prompts")],
      ["approval description", (value) => (approvalRequest(value).description = "wrong")],
      ["approval server", (value) => (approvalDetails(value).server = "wrong")],
      ["approval name", (value) => (approvalDetails(value).name = value.world.promptNames[1])],
      ["approval args missing", (value) => delete approvalDetails(value).args],
      [
        "approval args wrong",
        (value) => ((approvalDetails(value).args as Record<string, unknown>)[value.world.argumentNames[0]] = "wrong"),
      ],
      ["approval args reorder", reorderApprovalArgs],
      ["runtime server name", (value) => (value.world.runtimeConfigs[0]!.serverNames = ["wrong"])],
      ["runtime command", (value) => (value.world.runtimeConfigs[0]!.command = "node")],
      ["runtime args", (value) => (value.world.runtimeConfigs[0]!.args = ["$WORKSPACE/other.js"])],
      ["runtime cwd", (value) => (value.world.runtimeConfigs[0]!.cwd = "$WORKSPACE/subdir")],
      ["runtime transport", (value) => (value.world.runtimeConfigs[0]!.type = "http")],
      ["runtime resources", (value) => (value.world.runtimeConfigs[0]!.resources = true)],
      ["runtime prompts", (value) => (value.world.runtimeConfigs[0]!.prompts = false)],
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
      ["artifact omission", (value) => removeWorkspaceEntry(value, "orbital-workflow.txt")],
      ["artifact bytes", (value) => (workspaceEntry(value, "orbital-workflow.txt", "final").size += 1)],
      ["artifact hash", (value) => (workspaceEntry(value, "orbital-workflow.txt", "final").sha256 = "wrong")],
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
      ["thread get metadata", mutateThreadGetMetadata],
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
        "coupled name",
        (value) =>
          replaceDeep(value, (candidate) => candidate === value.world.intendedName, value.world.promptNames[1]),
      ],
      ["final prose", (value) => setFinal(value, "ORBITAL_WORKFLOW_COMPLETE done")],
      ["final fact", (value) => setFinal(value, value.world.fact)],
      ["final decoy", (value) => setFinal(value, value.world.decoyFacts[0]!)],
      ["final block extra", addFinalBlockField],
      ["coupled persisted output images", addCoupledPersistedOutputImages],
    ];
    expect(cases.length).toBeGreaterThanOrEqual(120);
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      const beforeMutation = JSON.stringify(changed);
      mutate(changed);
      expect(JSON.stringify(changed), `${label} must change the baseline`).not.toBe(beforeMutation);
      const result = mcpPromptGroundingTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
    expect(mcpPromptGroundingTask.evaluate(structuredClone(baseline))).toEqual({ passed: true });
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
    expect(cases).toHaveLength(8);
    for (const [label, mutate] of cases) {
      const changed = structuredClone(baseline);
      const output = changed.toolCalls[2]!.output as Record<string, unknown>;
      const beforeMutation = JSON.stringify(output);
      mutate(output);
      expect(JSON.stringify(output), `${label} must change the Anthropic write output`).not.toBe(beforeMutation);
      const result = mcpPromptGroundingTask.evaluate(changed);
      if (!result.passed) expect(result.dimension, label).toBeDefined();
    }
  });
});

interface AssembledExecutionOptions {
  includeProgressText?: boolean;
  recoveryKind?: "relative-path" | "missing-file";
  scopePromptList?: boolean;
  trailingPatchNewline?: boolean;
}

async function assembledExecution(
  profile: EvalProfile,
  assembledOptions: AssembledExecutionOptions = {},
): Promise<RuntimeEvalExecution<McpPromptGroundingWorld>> {
  const seed = "shared-seed-123";
  let call = 0;
  const result = await runRuntimeEvalExecution({
    task: mcpPromptGroundingTask,
    seed,
    profile,
    streamFunction(model, context, options) {
      call += 1;
      const intendedName = "current-orbital-handoff";
      const fact = token(seed, "ORBITAL_FACT");
      const args = {
        relay_designator: token(seed, "RELAY_DESIGNATOR"),
        handoff_window: token(seed, "HANDOFF_WINDOW"),
      };
      const response =
        call === 1
          ? assistantMessage(
              [
                ...(assembledOptions.includeProgressText
                  ? [{ type: "text" as const, text: "I will inspect prompts." }]
                  : []),
                {
                  type: "tool_call",
                  id: "prompt-list-call-1",
                  name: "mcp_list_prompts",
                  input: assembledOptions.scopePromptList ? { server: "fixture-workflows" } : {},
                },
              ],
              "tool_use",
            )
          : call === 2
            ? assistantMessage(
                [
                  {
                    type: "tool_call",
                    id: "prompt-get-call-2",
                    name: "mcp_get_prompt",
                    input: { server: "fixture-workflows", name: intendedName, args },
                  },
                ],
                "tool_use",
              )
            : call === 3 || (assembledOptions.recoveryKind !== undefined && call === 4)
              ? assistantMessage(
                  [
                    ...(assembledOptions.includeProgressText
                      ? [{ type: "text" as const, text: "I will write the rendered workflow." }]
                      : []),
                    {
                      type: "tool_call",
                      id: call === 3 ? "prompt-write-call-3" : "prompt-write-recovery-call-4",
                      name: profile.provider === "anthropic" ? "edit" : "apply_patch",
                      input:
                        profile.provider === "anthropic"
                          ? {
                              file_path:
                                assembledOptions.recoveryKind === "relative-path" && call === 3
                                  ? "orbital-workflow.txt"
                                  : join(cwdFromContext(context), "orbital-workflow.txt"),
                              old_string:
                                assembledOptions.recoveryKind === "missing-file" && call === 3
                                  ? "REPLACE_ME_FILE_DOES_NOT_EXIST"
                                  : "",
                              new_string: `${fact}\n`,
                              replace_all: false,
                            }
                          : {
                              patch: `*** Begin Patch\n*** Add File: orbital-workflow.txt\n+${fact}\n*** End Patch${assembledOptions.trailingPatchNewline ? "\n" : ""}`,
                            },
                    },
                  ],
                  "tool_use",
                )
              : assistantMessage([{ type: "text", text: "ORBITAL_WORKFLOW_COMPLETE" }]);
      return sequenceStream([response])(model, context, options);
    },
  });
  if (
    !assembledOptions.includeProgressText &&
    assembledOptions.recoveryKind === undefined &&
    !assembledOptions.scopePromptList &&
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
  return result.execution as RuntimeEvalExecution<McpPromptGroundingWorld>;
}

function token(seed: string, prefix: string): string {
  return `${prefix}_${seed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "seed"}`;
}

function cwdFromContext(context: StreamContext): string {
  const base = context.systemPrompt.find((section) => section.label === "base")?.content ?? "";
  const match = base.match(/^Current working directory: (.+)$/m);
  if (!match?.[1]) throw new Error("Missing runtime cwd in provider context.");
  return match[1];
}

function removeAdvertised(value: RuntimeEvalExecution<McpPromptGroundingWorld>, name: string) {
  value.advertisedTools[0]!.tools = value.advertisedTools[0]!.tools.filter((tool) => tool !== name);
}

function reorderAdvertised(value: RuntimeEvalExecution<McpPromptGroundingWorld>) {
  const tools = value.advertisedTools[0]!.tools;
  const list = tools.indexOf("mcp_list_prompts");
  const read = tools.indexOf("mcp_get_prompt");
  [tools[list], tools[read]] = [tools[read]!, tools[list]!];
}

function definition(value: RuntimeEvalExecution<McpPromptGroundingWorld>, index: number, call = 0) {
  return value.providerCalls[call]!.tools.items[index] as unknown as Record<string, unknown>;
}

function schemaProperties(value: Record<string, unknown>): Record<string, unknown> {
  return (value.inputSchema as { properties: Record<string, unknown> }).properties;
}

function mutateList(value: RuntimeEvalExecution<McpPromptGroundingWorld>, mutate: (items: unknown[]) => void) {
  const output = value.toolCalls[0]!.output as { output: string };
  const items = JSON.parse(output.output) as unknown[];
  mutate(items);
  output.output = JSON.stringify(items, null, 2);
}

function mutateListArgument(
  value: RuntimeEvalExecution<McpPromptGroundingWorld>,
  mutate: (items: Array<Record<string, unknown>>) => void,
) {
  mutateList(value, (items) => mutate((items[0] as { arguments: Array<Record<string, unknown>> }).arguments));
}

function mutateListArgumentRecord(
  value: RuntimeEvalExecution<McpPromptGroundingWorld>,
  mutate: (argument: Record<string, unknown>) => void,
) {
  mutateListArgument(value, (arguments_) => mutate(arguments_[0]!));
}

function promptArgs(value: RuntimeEvalExecution<McpPromptGroundingWorld>): Record<string, unknown> {
  return (value.toolCalls[1]!.input as { args: Record<string, unknown> }).args;
}

function reorderPromptArgs(value: RuntimeEvalExecution<McpPromptGroundingWorld>) {
  const input = value.toolCalls[1]!.input as { args: Record<string, unknown> };
  input.args = Object.fromEntries(Object.entries(input.args).reverse());
}

function traceMetadata(value: RuntimeEvalExecution<McpPromptGroundingWorld>, index: number) {
  return (value.toolCalls[index]!.output as { metadata: Record<string, unknown> }).metadata;
}

function expectedWrongPatch(value: RuntimeEvalExecution<McpPromptGroundingWorld>): string {
  return `*** Begin Patch\n*** Add File: wrong.txt\n+${value.world.fact}\n*** End Patch`;
}

function approvalParams(value: RuntimeEvalExecution<McpPromptGroundingWorld>) {
  return (value.approvals[0] as { params: Record<string, unknown> }).params;
}

function approvalRequest(value: RuntimeEvalExecution<McpPromptGroundingWorld>) {
  return approvalParams(value).request as Record<string, unknown>;
}

function approvalDetails(value: RuntimeEvalExecution<McpPromptGroundingWorld>) {
  return approvalRequest(value).details as Record<string, unknown>;
}

function reorderApprovalArgs(value: RuntimeEvalExecution<McpPromptGroundingWorld>) {
  const details = approvalDetails(value);
  details.args = Object.fromEntries(Object.entries(details.args as Record<string, unknown>).reverse());
}

function workspaceEntry(
  value: RuntimeEvalExecution<McpPromptGroundingWorld>,
  path: string,
  phase: "initial" | "final",
) {
  return value.workspace[phase].entries.find((entry) => entry.path === path)!;
}

function removeWorkspaceEntry(value: RuntimeEvalExecution<McpPromptGroundingWorld>, path: string) {
  value.workspace.final.entries = value.workspace.final.entries.filter((entry) => entry.path !== path);
}

function addWorkspaceEntry(
  value: RuntimeEvalExecution<McpPromptGroundingWorld>,
  path: string,
  phase: "initial" | "final",
) {
  value.workspace[phase].entries.push({ path, kind: "file", size: 1, sha256: "wrong", executable: false });
}

function addNotification(value: RuntimeEvalExecution<McpPromptGroundingWorld>) {
  value.turns[0]!.notifications.splice(-1, 0, {
    method: "thread/status/changed",
    params: { threadId: value.session.threadId, status: "idle" },
  } as never);
}

function mutateResolutionId(value: RuntimeEvalExecution<McpPromptGroundingWorld>) {
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

function setFinal(value: RuntimeEvalExecution<McpPromptGroundingWorld>, text: string) {
  const final = value.turns[0]!.messages[7] as { content: Array<{ type: string; text: string }> };
  final.content = [{ type: "text", text }];
}

function addFinalBlockField(value: RuntimeEvalExecution<McpPromptGroundingWorld>) {
  const final = value.turns[0]!.messages[7] as { content: Array<Record<string, unknown>> };
  final.content[0]!.extra = true;
}

function mutateThreadGetMetadata(value: RuntimeEvalExecution<McpPromptGroundingWorld>) {
  const item = value.threadReads[0]!.response.items[6] as unknown as { metadata: Record<string, unknown> };
  item.metadata.mcpPrompt = "wrong";
}

function mutateThreadWriteRender(value: RuntimeEvalExecution<McpPromptGroundingWorld>) {
  const item = value.threadReads[0]!.response.items[9] as unknown as { render: Record<string, unknown> };
  item.render.outputSummary = "wrong";
}

function mutateCoupledLifecycleWriteRender(value: RuntimeEvalExecution<McpPromptGroundingWorld>) {
  mutateCoupledLifecycleEvent(value, (event) => {
    if (event.type !== "tool_end" || event.toolCallId !== "prompt-write-call-3") return;
    (event.render as Record<string, unknown>).outputSummary = "wrong";
  });
}

function mutateCoupledLifecycleFinal(value: RuntimeEvalExecution<McpPromptGroundingWorld>) {
  mutateCoupledLifecycleEvent(value, (event) => {
    if (event.type !== "message_end" || !isFinalMessageRecord(event.message)) return;
    const content = (event.message as { content: Array<Record<string, unknown>> }).content;
    content[0]!.text = "wrong";
  });
}

function mutateCoupledLifecycleEvent(
  value: RuntimeEvalExecution<McpPromptGroundingWorld>,
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
    (content[0] as { text?: unknown }).text === "ORBITAL_WORKFLOW_COMPLETE"
  );
}

function addCoupledPersistedOutputImages(value: RuntimeEvalExecution<McpPromptGroundingWorld>) {
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
