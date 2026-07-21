// @summary Runtime eval for adapting to one runner-owned steering requirement after an exact target read

import type { RuntimeEvalExecution, RuntimeEvalTask, RuntimeToolTrace } from "../../runtime-task";
import type { EvalDimension } from "../../task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  writeFixture,
} from "./helpers";

const TARGET_PATH = "config/live-value.txt";
const ACTION_ID = "steer-during-fix-after-read";
const ACTION_TIMEOUT_MS = 30_000;

export interface SteerDuringFixWorld extends RuntimeFixtureWorld {
  targetPath: string;
  baseValue: string;
  originalRequestedValue: string;
  replacementValue: string;
  initialContent: string;
  initialHash: string;
  expectedHash: string;
  actionId: string;
  steerId: string;
  steeringContent: string;
}

export const steerDuringFixTask: RuntimeEvalTask<SteerDuringFixWorld> = {
  id: "steer-during-fix",
  description: "Adapt one exact file mutation to a replacement requirement injected after the target read.",
  fixtureVersion: "steer-during-fix-v5",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 5,
    maxToolCalls: 4,
    maxChangedFiles: 1,
    maxChangedBytes: 4_096,
    timeoutMs: 180_000,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["read", "apply_patch", "edit"],
    allowedCapabilities: ["read", "write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const baseValue = seededToken(seed, "BASE");
    const originalRequestedValue = seededToken(seed, "ORIGINAL_REQUEST");
    const replacementValue = seededToken(seed, "REPLACEMENT");
    const safeSeed = seed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "seed";
    const initialContent = `${baseValue}\n`;
    const expected = `${replacementValue}\n`;
    const steeringContent = `Change the requirement for ${TARGET_PATH}: it must contain exactly ${replacementValue} and one trailing newline. Do not use ${originalRequestedValue}.`;
    await writeFixture(root, {
      [TARGET_PATH]: initialContent,
      "control.txt": `${seededToken(seed, "CONTROL")}\n`,
    });
    return {
      root,
      seed,
      targetPath: TARGET_PATH,
      baseValue,
      originalRequestedValue,
      replacementValue,
      initialContent,
      expected,
      initialHash: sha256Text(initialContent),
      expectedHash: sha256Text(expected),
      actionId: ACTION_ID,
      steerId: `steer-during-fix-${safeSeed}`,
      steeringContent,
      protectedPaths: ["control.txt"],
      allowedChanges: [TARGET_PATH],
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: (world) => [
    {
      kind: "turn",
      message: `Inspect ${world.targetPath} to confirm its current value, then change that file so it contains exactly ${world.originalRequestedValue} and one trailing newline.`,
      actions: [
        {
          id: world.actionId,
          timeoutMs: ACTION_TIMEOUT_MS,
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
      ],
    },
  ],
  async verify(world, signal) {
    const started = performance.now();
    const actual = await exactFile(world.root, world.targetPath);
    const valid = !signal.aborted && actual === world.expected && !actual.includes(world.originalRequestedValue);
    return {
      argv: ["steer-during-fix-verifier", world.targetPath],
      exitCode: valid ? 0 : 1,
      elapsedMs: Math.round(performance.now() - started),
      stdout: valid ? `Exact replacement verified: ${world.expectedHash}\n` : "",
      stderr: valid ? "" : "Target bytes did not match the steered replacement requirement.\n",
      timedOut: signal.aborted,
    };
  },
  snapshotWorld: async (world) => ({ target: await exactFile(world.root, world.targetPath) }),
  evaluate(input) {
    const { world } = input;
    const toolFailure = validateTools(input);
    if (toolFailure) return toolFailure;
    if (input.verifier?.timedOut)
      return fail("verifier_timeout", "Independent exact-byte verification timed out.", "harness_terminal");
    if (input.verifier?.exitCode !== 0)
      return fail("verifier", "Independent exact-byte verification failed.", "format_contract");
    const final = input.workspace.final.entries.filter((entry) => entry.path === world.targetPath);
    if (final.length !== 1) return fail("artifact_missing", "The steered target artifact is missing.", "semantic_goal");
    if (final[0]?.sha256 !== world.expectedHash || final[0].size !== Buffer.byteLength(world.expected))
      return fail("final_hash", "The final target did not have the exact steered bytes and hash.", "format_contract");
    return { passed: true };
  },
};

function validateTools(input: RuntimeEvalExecution<SteerDuringFixWorld>) {
  const layout = toolLayout(input);
  if (!layout)
    return fail(
      "tool_count",
      "Expected one read and one provider-native write, with only the bounded recovery and confirmation reads permitted.",
      "behavior",
    );
  const { recovery, read, write, confirmation } = layout;
  const traces = [recovery, read, write, confirmation].filter(
    (trace): trace is RuntimeToolTrace => trace !== undefined,
  );
  if (traces.some((trace) => trace.threadId !== input.turns[0]!.threadId || trace.childThreadId !== undefined))
    return fail("tool_actor", "Every permitted trace must belong directly to the outer turn thread.", "runtime_policy");
  if (
    traces.some((trace, index) => index > 0 && trace.sequence <= traces[index - 1]!.sequence) ||
    new Set(traces.map((trace) => trace.sequence)).size !== traces.length ||
    (recovery !== undefined && read.sequence !== recovery.sequence + 1) ||
    (confirmation !== undefined && confirmation.sequence !== write.sequence + 1)
  )
    return fail("tool_order", "Read and write traces were not strictly increasing.", "behavior");
  if (
    read.name !== "read" ||
    read.capability !== "read" ||
    read.outcome !== "success" ||
    !(recovery
      ? exactObject(read.input, { file_path: `$WORKSPACE/${input.world.targetPath}` })
      : exactTargetInput(read.input, input.world.targetPath)) ||
    !JSON.stringify(read.output).includes(input.world.baseValue)
  )
    return fail("read", "The successful read did not target the exact seeded path and content.", "runtime_policy");
  if (write.capability !== "write" || write.outcome !== "success" || !isExactProviderNativeMutation(input, write))
    return fail("write", "The final trace was not the one exact provider-native target mutation.", "runtime_policy");
  if (
    confirmation &&
    (confirmation.name !== "read" ||
      confirmation.capability !== "read" ||
      confirmation.outcome !== "success" ||
      confirmation.error !== undefined ||
      !exactObject(confirmation.input, { file_path: `$WORKSPACE/${input.world.targetPath}` }) ||
      !JSON.stringify(confirmation.output).includes(input.world.replacementValue) ||
      JSON.stringify(confirmation.output).includes(input.world.originalRequestedValue))
  )
    return fail(
      "confirmation",
      "The optional confirmation did not read the exact post-write target value.",
      "runtime_policy",
    );
}

interface SteerToolLayout {
  recovery?: RuntimeToolTrace;
  read: RuntimeToolTrace;
  write: RuntimeToolTrace;
  confirmation?: RuntimeToolTrace;
}

function toolLayout(input: RuntimeEvalExecution<SteerDuringFixWorld>): SteerToolLayout | undefined {
  const calls = [...input.toolCalls];
  let recovery: RuntimeToolTrace | undefined;
  const expectedError = `Error: file_path must be absolute: ${input.world.targetPath}`;
  const first = calls[0];
  if (
    first &&
    (isExactMissingInstructionsProbe(first) ||
      (input.profile.provider === "anthropic" &&
        first.name === "read" &&
        first.capability === "read" &&
        first.outcome === "runtime_error" &&
        exactObject(first.input, { file_path: input.world.targetPath }) &&
        first.error === expectedError &&
        isRecord(first.output) &&
        first.output.output === expectedError &&
        isRecord(first.output.metadata) &&
        first.output.metadata.error === true))
  )
    recovery = calls.shift();
  if (calls.length < 2 || calls.length > 3) return undefined;
  const [read, write, confirmation] = calls;
  return read && write ? { recovery, read, write, confirmation } : undefined;
}

function isExactMissingInstructionsProbe(trace: RuntimeToolTrace): boolean {
  const error = "Error: File not found: $WORKSPACE/AGENTS.md";
  return (
    trace.name === "read" &&
    trace.capability === "read" &&
    trace.outcome === "runtime_error" &&
    exactObject(trace.input, { file_path: "$WORKSPACE/AGENTS.md" }) &&
    trace.error === error &&
    isRecord(trace.output) &&
    trace.output.output === error &&
    isRecord(trace.output.metadata) &&
    trace.output.metadata.error === true
  );
}

function isExactProviderNativeMutation(
  input: RuntimeEvalExecution<SteerDuringFixWorld>,
  call: RuntimeToolTrace,
): boolean {
  const { world } = input;
  if (input.profile.provider === "openai") return call.name === "apply_patch" && isExactOpenAiPatch(call.input, world);
  if (input.profile.provider === "anthropic")
    return (
      call.name === "edit" &&
      [
        { old_string: world.initialContent, new_string: world.expected },
        { old_string: world.baseValue, new_string: world.replacementValue },
      ].some(({ old_string, new_string }) =>
        exactObject(call.input, {
          file_path: `$WORKSPACE/${world.targetPath}`,
          old_string,
          new_string,
          replace_all: false,
        }),
      )
    );
  return false;
}

function isExactOpenAiPatch(value: unknown, world: SteerDuringFixWorld): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.patch !== "string") return false;
  const lines = value.patch.trimEnd().split("\n");
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") return false;
  const fileOperations = lines.filter(
    (line) =>
      line.startsWith("*** Add File:") ||
      line.startsWith("*** Update File:") ||
      line.startsWith("*** Delete File:") ||
      line.startsWith("*** Move to:"),
  );
  if (JSON.stringify(fileOperations) !== JSON.stringify([`*** Update File: ${world.targetPath}`])) return false;
  const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("---"));
  return (
    JSON.stringify(additions) === JSON.stringify([`+${world.replacementValue}`]) &&
    (JSON.stringify(deletions) === JSON.stringify([`-${world.baseValue}`]) ||
      JSON.stringify(deletions) === JSON.stringify([`-${world.baseValue}`, "-"]))
  );
}

function exactTargetInput(value: unknown, targetPath: string): boolean {
  if (!isRecord(value)) return false;
  return value.file_path === targetPath || value.file_path === `$WORKSPACE/${targetPath}`;
}

function exactObject(value: unknown, expected: Record<string, unknown>): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => stableStringify(value[key]) === stableStringify(expected[key]))
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `steer_during_fix.${code}`, message, dimension };
}
