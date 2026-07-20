// @summary Runtime eval for adapting to a bundled AgentLoopHook injection after a real tool boundary

import type { AgentContextInjection, AgentLoopHook } from "@diligent/core/agent";
import type { BundledToolProvider } from "@diligent/runtime";
import type { RuntimeEvalExecution, RuntimeEvalTask, RuntimeWorldSnapshot } from "../../runtime-task";
import type { EvalDimension } from "../../task";
import {
  createIsolatedFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  verifyExactFiles,
  writeFixture,
} from "./helpers";

const BRIEF_PATH = "deployment-brief.txt";
const OUTPUT_PATH = "RESULT.txt";
const HOOK_SOURCE = "eval-loop-context-adaptation";
const PRESENTATION = {
  kind: "requirement-update",
  title: "Requirement updated",
  content: "The active deployment lane changed after the project brief was inspected.",
} as const;

export interface LoopContextHookRecord {
  sequence: number;
  phase: "before_turn" | "tool_result";
  turnId: string;
  injected?: boolean;
  toolName?: string;
  toolCallId?: string;
  success?: boolean;
}

export interface LoopContextAdaptationWorld extends RuntimeFixtureWorld {
  initialValue: string;
  injectedValue: string;
  initialBrief: string;
  injectedContext: string;
  clientPrompt: string;
  expectedHash: string;
  hookRecords: LoopContextHookRecord[];
  factoryCalls: Array<{ agentKind: string; cwd: string; tools: string[] }>;
}

export const loopContextAdaptationTask: RuntimeEvalTask<LoopContextAdaptationWorld> = {
  id: "loop-context-adaptation",
  description: "Adapt an exact pending workspace result after an internal loop-context requirement update.",
  fixtureVersion: "loop-context-adaptation-v7",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 4,
    maxToolCalls: 3,
    maxChangedFiles: 1,
    maxChangedBytes: 512,
    timeoutMs: 180_000,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["read", "apply_patch", "edit"],
    allowedCapabilities: ["read", "write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const initialValue = seededToken(seed, "LANE_INITIAL");
    const injectedValue = seededToken(seed, "LANE_UPDATED");
    const initialBrief = `Current deployment lane: ${initialValue}\nRecord only that lane in RESULT.txt with one trailing newline.\n`;
    const injectedContext =
      `The deployment requirement changed. The active lane is now ${injectedValue}. ` +
      `Disregard the earlier ${initialValue} lane and ensure RESULT.txt contains only ${injectedValue} with one trailing newline.`;
    const clientPrompt =
      "No other project file is relevant. Consult deployment-brief.txt; RESULT.txt does not exist yet, so create it to satisfy the current requirement and leave it exact.";
    const expected = `${injectedValue}\n`;
    await writeFixture(root, { [BRIEF_PATH]: initialBrief, ".git/.keep": "fixture boundary\n" });
    return {
      root,
      seed,
      initialValue,
      injectedValue,
      initialBrief,
      injectedContext,
      clientPrompt,
      expected,
      expectedHash: sha256Text(expected),
      hookRecords: [],
      factoryCalls: [],
      protectedPaths: [BRIEF_PATH, ".git/.keep"],
      allowedChanges: [OUTPUT_PATH],
    };
  },
  createRuntimeConfig: createIsolatedFixtureRuntimeConfig,
  createBundledToolProviders(world): readonly BundledToolProvider[] {
    return [
      {
        id: HOOK_SOURCE,
        createTools: () => [],
        createAgentLoopHooks(context): readonly AgentLoopHook[] {
          world.factoryCalls.push({
            agentKind: context.agentKind,
            cwd: context.cwd,
            tools: context.tools.map((tool) => tool.name),
          });
          let armed = false;
          let injected = false;
          const hook: AgentLoopHook = {
            id: HOOK_SOURCE,
            beforeTurn({ turnId }) {
              const shouldInject = armed && !injected;
              world.hookRecords.push({
                sequence: world.hookRecords.length + 1,
                phase: "before_turn",
                turnId,
                injected: shouldInject,
              });
              if (!shouldInject) return;
              injected = true;
              return [injection(world)];
            },
            onToolResult({ turnId, toolCall, result }) {
              const success = !result.isError;
              world.hookRecords.push({
                sequence: world.hookRecords.length + 1,
                phase: "tool_result",
                turnId,
                toolName: toolCall.name,
                toolCallId: toolCall.id,
                success,
              });
              if (
                !armed &&
                success &&
                toolCall.name === "read" &&
                isRecord(toolCall.input) &&
                typeof toolCall.input.file_path === "string" &&
                toolCall.input.file_path.replaceAll("\\", "/").endsWith(`/${BRIEF_PATH}`) &&
                String(result.output).includes(world.initialValue)
              )
                armed = true;
            },
          };
          return [hook];
        },
      },
    ];
  },
  createSteps: (world) => [{ kind: "turn", mode: "default", message: world.clientPrompt }],
  verify: (world, signal) => verifyExactFiles(world, { [OUTPUT_PATH]: world.expected }, signal),
  snapshotWorld: async (world) => ({
    result: await exactFile(world.root, OUTPUT_PATH),
    hookRecords: structuredClone(world.hookRecords),
    factoryCalls: structuredClone(world.factoryCalls),
  }),
  evaluate(input) {
    const failure = validateToolsAndResult(input) ?? validateIsolation(input);
    if (failure) return failure;
    const diagnostics = [];
    if (absentFileEditRecovery(input))
      diagnostics.push({
        dimension: "efficiency" as const,
        code: "loop_context_adaptation.absent_file_recovery",
        message: "One bounded provider-neutral absent-file recovery preceded the adapted write.",
      });
    if (missingRootInstructionsRead(input))
      diagnostics.push({
        dimension: "efficiency" as const,
        code: "loop_context_adaptation.missing_root_instructions",
        message: "One bounded root-instructions probe failed before the adapted write.",
      });
    if (postWriteConfirmationRead(input))
      diagnostics.push({
        dimension: "efficiency" as const,
        code: "loop_context_adaptation.post_write_confirmation",
        message: "One bounded target read confirmed the adapted write before completion.",
      });
    return diagnostics.length > 0 ? { passed: true, diagnostics } : { passed: true };
  },
};

function injection(world: LoopContextAdaptationWorld): AgentContextInjection {
  return {
    source: HOOK_SOURCE,
    content: world.injectedContext,
    metadata: { presentation: PRESENTATION },
  };
}

function validateToolsAndResult(input: RuntimeEvalExecution<LoopContextAdaptationWorld>) {
  const recovery = absentFileEditRecovery(input);
  const instructionsProbe = missingRootInstructionsRead(input);
  const confirmation = postWriteConfirmationRead(input);
  const read = input.toolCalls[0];
  const write = recovery?.succeeded ?? input.toolCalls[instructionsProbe ? 2 : 1];
  const expectedToolCount = recovery || instructionsProbe || confirmation ? 3 : 2;
  const expectedWriteSequence = recovery || instructionsProbe ? 3 : 2;
  const expectedReadInput = { file_path: `$WORKSPACE/${BRIEF_PATH}` };
  if (
    input.toolCalls.length !== expectedToolCount ||
    read?.sequence !== 1 ||
    read.name !== "read" ||
    read.capability !== "read" ||
    read.outcome !== "success" ||
    JSON.stringify(read.input) !== JSON.stringify(expectedReadInput) ||
    write?.sequence !== expectedWriteSequence ||
    !["apply_patch", "edit"].includes(write.name) ||
    write.capability !== "write" ||
    write.outcome !== "success" ||
    !hasExactWriteInput(write.name, write.input, input.world.expected) ||
    input.verifier?.exitCode !== 0 ||
    input.verifier.timedOut ||
    input.verifier.argv.join(" ") !== `eval-exact-files ${OUTPUT_PATH}`
  )
    return fail("tools", "The exact read-then-adapted-write trace or independent verifier failed.");
  const output = input.workspace.final.entries.find((entry) => entry.path === OUTPUT_PATH);
  if (
    output?.sha256 !== input.world.expectedHash ||
    output.sha256 === sha256Text(`${input.world.initialValue}\n`) ||
    !hasExactFinalFixture(
      input.workspace.final,
      input.world.initialBrief,
      input.world.expected,
      input.world.expectedHash,
    )
  )
    return fail("result", "The final artifact did not contain the exclusive injected value.");
  if (!isValidFinalAssistant(input.turns[0]!.messages.at(-1), input.world.injectedValue, input.world.initialValue))
    return fail("final_answer", "The final answer did not exclusively report the adapted result.");
}

function postWriteConfirmationRead(input: RuntimeEvalExecution<LoopContextAdaptationWorld>) {
  if (input.toolCalls.length !== 3) return undefined;
  const trace = input.toolCalls[2];
  const output = isRecord(trace?.output) ? trace.output.output : undefined;
  return trace?.sequence === 3 &&
    trace.name === "read" &&
    trace.capability === "read" &&
    trace.outcome === "success" &&
    trace.error === undefined &&
    trace.threadId === input.session.threadId &&
    trace.childThreadId === undefined &&
    JSON.stringify(trace.input) === JSON.stringify({ file_path: `$WORKSPACE/${OUTPUT_PATH}` }) &&
    output === `1\t${input.world.expected.trimEnd()}\n2\t`
    ? trace
    : undefined;
}

function missingRootInstructionsRead(input: RuntimeEvalExecution<LoopContextAdaptationWorld>) {
  if (input.toolCalls.length !== 3) return undefined;
  const trace = input.toolCalls[1];
  const error = "Error: File not found: $WORKSPACE/AGENTS.md";
  return trace?.sequence === 2 &&
    trace.name === "read" &&
    trace.capability === "read" &&
    trace.outcome === "runtime_error" &&
    trace.threadId === input.session.threadId &&
    trace.childThreadId === undefined &&
    JSON.stringify(trace.input) === JSON.stringify({ file_path: "$WORKSPACE/AGENTS.md" }) &&
    trace.error === error
    ? trace
    : undefined;
}

function absentFileEditRecovery(input: RuntimeEvalExecution<LoopContextAdaptationWorld>) {
  if (input.profile.provider !== "anthropic" || input.toolCalls.length !== 3) return undefined;
  const failed = input.toolCalls[1];
  const succeeded = input.toolCalls[2];
  const failedInput = isRecord(failed?.input) ? failed.input : undefined;
  if (
    !failed ||
    !succeeded ||
    failed.name !== "edit" ||
    failed.capability !== "write" ||
    failed.outcome !== "runtime_error" ||
    failed.sequence + 1 !== succeeded.sequence ||
    failedInput?.file_path !== `$WORKSPACE/${OUTPUT_PATH}` ||
    typeof failedInput.old_string !== "string" ||
    failedInput.old_string.length === 0 ||
    failedInput.new_string !== input.world.expected ||
    failedInput.replace_all !== false ||
    !failed.error?.includes("ENOENT") ||
    !failed.error.includes(OUTPUT_PATH) ||
    succeeded.name !== "edit" ||
    succeeded.capability !== "write" ||
    succeeded.outcome !== "success" ||
    !hasExactWriteInput(succeeded.name, succeeded.input, input.world.expected)
  )
    return undefined;
  return { failed, succeeded };
}

function validateIsolation(input: RuntimeEvalExecution<LoopContextAdaptationWorld>) {
  if (
    input.childSessions.length !== 0 ||
    input.compactions.length !== 0 ||
    input.protocolActions.length !== 0 ||
    input.approvals.length !== 0 ||
    input.userInputRequests.length !== 0 ||
    input.toolOutputFiles.length !== 0 ||
    input.toolCalls.some((call) => !["read", "apply_patch", "edit"].includes(call.name))
  )
    return fail(
      "forbidden",
      "Child, compaction, action, approval, input, network, output-file, or undeclared tools are forbidden.",
    );
  const initialBrief = input.workspace.initial.entries.find((entry) => entry.path === BRIEF_PATH);
  const finalBrief = input.workspace.final.entries.find((entry) => entry.path === BRIEF_PATH);
  const initialKeep = input.workspace.initial.entries.find((entry) => entry.path === ".git/.keep");
  const finalKeep = input.workspace.final.entries.find((entry) => entry.path === ".git/.keep");
  if (
    JSON.stringify(initialBrief) !== JSON.stringify(finalBrief) ||
    JSON.stringify(initialKeep) !== JSON.stringify(finalKeep) ||
    input.runtimeState.diff.some((change) => !["infrastructure", "sessions"].includes(change.category))
  )
    return fail("workspace", "A protected project path or forbidden runtime-state category changed.");
}

function hasExactFinalFixture(
  snapshot: RuntimeWorldSnapshot,
  initialBrief: string,
  expected: string,
  expectedHash: string,
): boolean {
  const entries = snapshot.entries.filter(
    (entry) => entry.path !== ".diligent" && !entry.path.startsWith(".diligent/"),
  );
  return (
    entries.length === 4 &&
    hasExactDirectory(entries, ".git") &&
    hasExactFile(entries, ".git/.keep", "fixture boundary\n", sha256Text("fixture boundary\n")) &&
    hasExactFile(entries, BRIEF_PATH, initialBrief, sha256Text(initialBrief)) &&
    hasExactFile(entries, OUTPUT_PATH, expected, expectedHash)
  );
}

function hasExactDirectory(entries: RuntimeWorldSnapshot["entries"], path: string): boolean {
  return (
    JSON.stringify(entries.find((entry) => entry.path === path)) ===
    JSON.stringify({ path, kind: "directory", size: 0 })
  );
}

function hasExactFile(
  entries: RuntimeWorldSnapshot["entries"],
  path: string,
  content: string,
  sha256: string,
): boolean {
  const size = new TextEncoder().encode(content).byteLength;
  return (
    JSON.stringify(entries.find((entry) => entry.path === path)) ===
    JSON.stringify({ path, kind: "file", size, sha256, executable: false })
  );
}

function hasExactWriteInput(toolName: string, input: unknown, expected: string): boolean {
  if (toolName === "edit") {
    return (
      JSON.stringify(input) ===
      JSON.stringify({
        file_path: `$WORKSPACE/${OUTPUT_PATH}`,
        old_string: "",
        new_string: expected,
        replace_all: false,
      })
    );
  }
  if (toolName !== "apply_patch" || !isRecord(input) || typeof input.patch !== "string") return false;
  const expectedPatch = `*** Begin Patch\n*** Add File: ${OUTPUT_PATH}\n+${expected.trimEnd()}\n*** End Patch`;
  return input.patch === expectedPatch || input.patch === `${expectedPatch}\n`;
}

function isValidFinalAssistant(value: unknown, expected: string, forbidden: string): boolean {
  if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content) || value.content.length !== 1)
    return false;
  const block = value.content[0];
  if (!isRecord(block) || Object.keys(block).length !== 2 || block.type !== "text" || typeof block.text !== "string")
    return false;
  return block.text.length <= 512 && block.text.split(expected).length === 2 && !block.text.includes(forbidden);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const LOOP_FAILURE_DIMENSIONS = {
  tools: "behavior",
  result: "semantic_goal",
  final_answer: "semantic_goal",
  forbidden: "runtime_policy",
  workspace: "runtime_policy",
} as const satisfies Record<string, EvalDimension>;

function fail(code: keyof typeof LOOP_FAILURE_DIMENSIONS, message: string) {
  return {
    passed: false as const,
    code: `loop_context_adaptation.${code}`,
    message,
    dimension: LOOP_FAILURE_DIMENSIONS[code],
  };
}
