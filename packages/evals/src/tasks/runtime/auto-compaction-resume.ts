// @summary Runtime eval for exact continuation after automatic in-turn context compaction

import { COMPACTION_MIN_INPUT_TOKENS } from "@diligent/core/compaction-contract";
import type { BundledToolProvider, RuntimeConfig } from "@diligent/runtime";
import { z } from "zod";
import type { RuntimeEvalExecution, RuntimeEvalTask, RuntimeToolTrace } from "../../runtime-task";
import type { EvalDimension, EvalProfile } from "../../task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  writeFixture,
} from "./helpers";

const TARGET_PATH = "COMPACTED.txt";
const CONTROL_PATH = "control.txt";
const INFLATE_TOOL = "inflate_context";
const INFLATE_MARKER = "AUTO_COMPACTION_INFLATE_RESULT";
const INFLATE_OUTPUT = `${INFLATE_MARKER}\n${"x".repeat(COMPACTION_MIN_INPUT_TOKENS * 4)}`;
const INFLATE_MAX_OUTPUT_BYTES = Buffer.byteLength(INFLATE_OUTPUT) + 1_024;
const RESERVE_PERCENT = 99.95;

export interface AutoCompactionResumeWorld extends RuntimeFixtureWorld {
  facts: string[];
  targetPath: string;
  expectedHash: string;
  controlHash: string;
  summaryBody: string;
}

export const autoCompactionResumeTask: RuntimeEvalTask<AutoCompactionResumeWorld> = {
  id: "auto-compaction-resume",
  description: "Continue one outer turn after automatic compaction and reconstruct three exact seeded facts.",
  fixtureVersion: "auto-compaction-resume-v2",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 5,
    maxToolCalls: 2,
    maxChangedFiles: 1,
    maxChangedBytes: 4_096,
    timeoutMs: 180_000,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: [INFLATE_TOOL, "apply_patch", "edit"],
    allowedCapabilities: ["execute", "write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const facts = [seededToken(seed, "ORBIT"), seededToken(seed, "CIPHER"), seededToken(seed, "ANCHOR")];
    const expected = renderArtifact(facts);
    const control = `${seededToken(seed, "CONTROL")}\n`;
    const summaryBody = [
      "## Goal",
      `Create ${TARGET_PATH} after automatic context compaction.`,
      "",
      "## Critical Context",
      `ORBIT=${facts[0]}`,
      `CIPHER=${facts[1]}`,
      `ANCHOR=${facts[2]}`,
      `The inflate tool already completed. Next, write ${TARGET_PATH} with exactly those three lines.`,
    ].join("\n");
    await writeFixture(root, { [CONTROL_PATH]: control });
    return {
      root,
      seed,
      facts,
      targetPath: TARGET_PATH,
      expected,
      expectedHash: sha256Text(expected),
      controlHash: sha256Text(control),
      summaryBody,
      protectedPaths: [CONTROL_PATH],
      allowedChanges: [TARGET_PATH],
    };
  },
  createRuntimeConfig: createAutoCompactionRuntimeConfig,
  createBundledToolProviders: () => [inflateProvider()],
  createSteps: (world) => [
    {
      kind: "turn",
      message: [
        `Preserve these opaque project facts exactly: ORBIT=${world.facts[0]}; CIPHER=${world.facts[1]}; ANCHOR=${world.facts[2]}.`,
        `First use the context inflation capability exactly once to complete bounded preparatory work. Then create ${world.targetPath} with exactly three lines in the same declared order and one trailing newline. Each line must use LABEL=value format.`,
        "After the file is created, reply exactly Done.",
      ].join(" "),
    },
  ],
  async verify(world, signal) {
    const started = performance.now();
    const actual = await exactFile(world.root, world.targetPath);
    const valid = !signal.aborted && actual === world.expected;
    return {
      argv: ["auto-compaction-resume-verifier", world.targetPath],
      exitCode: valid ? 0 : 1,
      elapsedMs: Math.round(performance.now() - started),
      stdout: valid ? `Exact compacted-context artifact verified: ${world.expectedHash}\n` : "",
      stderr: valid ? "" : "Artifact bytes did not reconstruct all seeded compacted facts exactly.\n",
      timedOut: signal.aborted,
    };
  },
  snapshotWorld: async (world) => ({ artifact: await exactFile(world.root, world.targetPath) }),
  evaluate(input) {
    const turn = input.turns[0];
    const manualFailure = validateNoManualCompaction(input);
    if (manualFailure) return manualFailure;
    const toolFailure = validateTools(input);
    if (toolFailure) return toolFailure;
    if (input.providerCalls.length > autoCompactionResumeTask.limits.maxTurns + 3)
      return fail("unbounded_recovery", "Provider recovery exceeded the bounded policy.", "runtime_policy");

    if (input.verifier?.timedOut)
      return fail("verifier_timeout", "Independent exact-byte verification timed out.", "harness_terminal");
    if (input.verifier?.exitCode !== 0)
      return fail("verifier", "Independent exact-byte verification failed.", "format_contract");
    const finalTarget = input.workspace.final.entries.filter((entry) => entry.path === input.world.targetPath);
    const finalControl = input.workspace.final.entries.filter((entry) => entry.path === CONTROL_PATH);
    if (finalTarget.length !== 1)
      return fail("artifact_missing", "The required reconstructed artifact is missing.", "semantic_goal");
    if (
      finalTarget[0]?.sha256 !== input.world.expectedHash ||
      finalTarget[0]?.size !== Buffer.byteLength(input.world.expected)
    )
      return fail("artifact_bytes", "Final artifact bytes, size, or hash were incorrect.", "format_contract");
    if (finalControl.length !== 1 || finalControl[0]?.sha256 !== input.world.controlHash)
      return fail("protected_state", "The protected control fixture changed.", "runtime_policy");
    if (hasUndeclaredProjectEntry(input))
      return fail("undeclared_mutation", "An undeclared project mutation was present.", "runtime_policy");

    const diagnostics = [];
    if (input.providerCalls.length > 4) {
      diagnostics.push({
        dimension: "efficiency" as const,
        code: "auto_compaction_resume.provider_call_variation",
        message: `Observed ${input.providerCalls.length} provider calls; bounded variation did not affect correctness.`,
      });
    }
    const automaticCompactions = turn ? eventNotices(turn.notifications, "compaction_end").length : 0;
    if (automaticCompactions > 1) {
      diagnostics.push({
        dimension: "efficiency" as const,
        code: "auto_compaction_resume.additional_compaction",
        message: `Observed ${automaticCompactions} shrinking automatic compactions.`,
      });
    }
    return diagnostics.length > 0 ? { passed: true, diagnostics } : { passed: true };
  },
};

async function createAutoCompactionRuntimeConfig(
  world: AutoCompactionResumeWorld,
  profile: EvalProfile,
): Promise<RuntimeConfig> {
  const config = await createFixtureRuntimeConfig(world, profile);
  return {
    ...config,
    compaction: {
      enabled: true,
      reservePercent: RESERVE_PERCENT,
      timeoutMs: 30_000,
    },
  };
}

function inflateProvider(): BundledToolProvider {
  return {
    id: "eval-auto-compaction-inflate-provider",
    createTools: () => [
      {
        name: INFLATE_TOOL,
        description: "Perform deterministic bounded preparatory work that expands the current context.",
        parameters: z.object({}).strict(),
        execute: async () => ({ output: INFLATE_OUTPUT, maxOutputBytes: INFLATE_MAX_OUTPUT_BYTES }),
      },
    ],
  };
}

function validateNoManualCompaction(input: RuntimeEvalExecution<AutoCompactionResumeWorld>) {
  if (input.compactions.length !== 0)
    return fail("manual_compaction", "Runner-owned manual compaction evidence must be empty.", "runtime_policy");
}

function validateTools(input: RuntimeEvalExecution<AutoCompactionResumeWorld>) {
  if (input.toolCalls.length !== 2)
    return fail("tool_count", "Expected exactly one inflate call and one artifact write.", "runtime_policy");
  const [inflate, write] = input.toolCalls;
  if (!inflate || !write || inflate.sequence >= write.sequence || inflate.sequence === write.sequence)
    return fail("tool_order", "Inflate and write traces were not strictly ordered.", "behavior");
  if (inflate.name !== INFLATE_TOOL || inflate.capability !== "execute" || inflate.outcome !== "success")
    return fail("inflate", "The first trace was not one successful context-inflation choice.", "runtime_policy");
  const writeFailure = validateWrite(input, write);
  if (writeFailure) return writeFailure;
  const rootThreadId = input.turns[0]?.threadId;
  if (rootThreadId && (inflate.threadId !== rootThreadId || write.threadId !== rootThreadId))
    return fail("tool_thread", "Tool traces did not remain attributed to the root thread.", "runtime_policy");
}

function validateWrite(input: RuntimeEvalExecution<AutoCompactionResumeWorld>, call: RuntimeToolTrace) {
  if (call.capability !== "write" || call.outcome !== "success")
    return fail("write_policy", "The artifact write did not succeed under the write allowlist.", "runtime_policy");

  let content: string | undefined;
  if (input.profile.provider === "openai") {
    if (call.name !== "apply_patch" || !isRecord(call.input) || typeof call.input.patch !== "string")
      return fail("write_tool", "OpenAI must use the allowed patch tool for the target artifact.", "runtime_policy");
    content = addedFileContent(call.input.patch, input.world.targetPath);
    if (content === undefined)
      return fail("write_path", "The patch did not exclusively add the declared target path.", "runtime_policy");
  } else if (input.profile.provider === "anthropic") {
    if (call.name !== "edit" || !isRecord(call.input))
      return fail("write_tool", "Anthropic must use the allowed edit tool for the target artifact.", "runtime_policy");
    if (call.input.file_path !== `$WORKSPACE/${input.world.targetPath}`)
      return fail("write_path", "The edit did not target the declared artifact path.", "runtime_policy");
    content = typeof call.input.new_string === "string" ? call.input.new_string : undefined;
  } else {
    return fail("provider", "The provider has no declared artifact-write route.", "behavior");
  }

  if (!content || !input.world.facts.every((fact) => content.includes(fact)))
    return fail("facts", "The artifact write did not reconstruct every seeded fact.", "semantic_goal");
  if (content !== input.world.expected)
    return fail("write_bytes", "The artifact write violated the prompt-declared exact bytes.", "format_contract");
}

function addedFileContent(patch: string, targetPath: string): string | undefined {
  const lines = patch.trimEnd().split("\n");
  if (lines[0] !== "*** Begin Patch" || lines[1] !== `*** Add File: ${targetPath}` || lines.at(-1) !== "*** End Patch")
    return undefined;
  if (lines.slice(2, -1).some((line) => !line.startsWith("+"))) return undefined;
  return `${lines
    .slice(2, -1)
    .map((line) => line.slice(1))
    .join("\n")}\n`;
}

function hasUndeclaredProjectEntry(input: RuntimeEvalExecution<AutoCompactionResumeWorld>): boolean {
  const allowed = new Set([CONTROL_PATH, input.world.targetPath]);
  return input.workspace.final.entries.some(
    (entry) =>
      entry.kind !== "directory" &&
      entry.path !== ".diligent" &&
      !entry.path.startsWith(".diligent/") &&
      !allowed.has(entry.path),
  );
}

function renderArtifact(facts: string[]): string {
  return `ORBIT=${facts[0]}\nCIPHER=${facts[1]}\nANCHOR=${facts[2]}\n`;
}

function eventNotices(notices: RuntimeEvalExecution<unknown>["turns"][number]["notifications"], type: string) {
  return notices.map((notice, index) => ({ notice, index })).filter(({ notice }) => eventType(notice) === type);
}

function eventType(notice: RuntimeEvalExecution<unknown>["turns"][number]["notifications"][number]): unknown {
  return notificationEvent(notice)?.type;
}

function notificationEvent(
  notice: RuntimeEvalExecution<unknown>["turns"][number]["notifications"][number],
): Record<string, unknown> | undefined {
  if (notice.method !== "agent/event" || !isRecord(notice.params)) return undefined;
  const params = notice.params as unknown;
  return isRecord(params) && isRecord(params.event) ? params.event : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `auto_compaction_resume.${code}`, message, dimension };
}
