// @summary Runtime eval for visible plan creation, ordered progress updates, implementation, and verification

import type { RuntimeEvalTask, RuntimeToolTrace } from "../../runtime-task";
import type { EvalDimension } from "../../task";
import {
  createIsolatedFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  runVerifier,
  seededToken,
  sha256Text,
  writeFixture,
} from "./helpers";

export interface PlanProgressWorld extends RuntimeFixtureWorld {
  base: string;
  middle: string;
  final: string;
  outputs: Record<string, string>;
  outputHashes: Record<string, string>;
  planSteps: string[];
}

const OUTPUT_PATHS = ["generated/stage-one.txt", "generated/stage-two.txt", "generated/stage-three.txt"];

export const planProgressTask: RuntimeEvalTask<PlanProgressWorld> = {
  id: "plan-progress",
  description: "Create and maintain a one-active-step plan while implementing an ordered three-file pipeline.",
  fixtureVersion: "plan-progress-v6",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 24, maxToolCalls: 24, timeoutMs: 300_000 },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["read", "plan", "write", "edit", "multi_edit", "apply_patch", "bash"],
    allowedCapabilities: ["read", "write", "execute"],
    allowedCommands: ["bun test"],
  },
  async setup(seed, root) {
    const base = seededToken(seed, "BASE");
    const middle = seededToken(seed, "MIDDLE");
    const final = seededToken(seed, "FINAL");
    const outputs = {
      [OUTPUT_PATHS[0]!]: `${base}\n`,
      [OUTPUT_PATHS[1]!]: `${base}:${middle}\n`,
      [OUTPUT_PATHS[2]!]: `${base}:${middle}:${final}\n`,
    };
    const planSteps = [
      `${seededToken(seed, "STEP_ONE")}: Create generated/stage-one.txt`,
      `${seededToken(seed, "STEP_TWO")}: Create generated/stage-two.txt from stage one`,
      `${seededToken(seed, "STEP_THREE")}: Create generated/stage-three.txt from stage two`,
      `${seededToken(seed, "STEP_VERIFY")}: Verify the completed pipeline`,
    ];
    await writeFixture(root, {
      ".git/.keep": "fixture boundary\n",
      "AGENTS.md":
        "Implement the generated stages strictly in numeric order. Each later stage must extend the exact prior stage. Keep a visible plan current and verify with exactly `bun test`.\n",
      "package.json": `${JSON.stringify({ scripts: { test: "bun test test/pipeline.test.ts" } }, null, 2)}\n`,
      "inputs/base.txt": `${base}\n`,
      "inputs/suffixes.txt": `${middle}\n${final}\n`,
      "test/pipeline.test.ts": [
        'import { expect, test } from "bun:test";',
        'const base = (await Bun.file("inputs/base.txt").text()).trimEnd();',
        'const [middle, final] = (await Bun.file("inputs/suffixes.txt").text()).trimEnd().split("\\n");',
        "const expected = {",
        '  "generated/stage-one.txt": base + "\\n",',
        '  "generated/stage-two.txt": base + ":" + middle + "\\n",',
        '  "generated/stage-three.txt": base + ":" + middle + ":" + final + "\\n",',
        "};",
        "for (const [path, value] of Object.entries(expected))",
        "  test(path, async () => expect(await Bun.file(path).text()).toBe(value));",
        "",
      ].join("\n"),
    });
    return {
      root,
      seed,
      base,
      middle,
      final,
      outputs,
      outputHashes: Object.fromEntries(Object.entries(outputs).map(([path, value]) => [path, sha256Text(value)])),
      planSteps,
      expected: outputs[OUTPUT_PATHS[2]!]!,
      protectedPaths: [
        ".git/.keep",
        "AGENTS.md",
        "package.json",
        "inputs/base.txt",
        "inputs/suffixes.txt",
        "test/pipeline.test.ts",
      ],
      allowedChanges: OUTPUT_PATHS,
    };
  },
  createRuntimeConfig: createIsolatedFixtureRuntimeConfig,
  createSteps: () => [
    {
      kind: "turn",
      mode: "execute",
      message:
        "Implement the three-stage generated-file pipeline described by the project. Use the read tool for inputs/base.txt and inputs/suffixes.txt; the only permitted shell command is exactly bun test. Keep a visible plan current and finish only after verification succeeds.",
    },
  ],
  verify: (world, signal) => runVerifier(world, ["bun", "test"], signal),
  snapshotWorld: async (world) => ({
    outputs: Object.fromEntries(
      await Promise.all(OUTPUT_PATHS.map(async (path) => [path, await exactFile(world.root, path)])),
    ),
  }),
  evaluate(input) {
    const planCalls = input.toolCalls
      .filter((call) => call.name === "plan" && call.outcome === "success")
      .sort((left, right) => left.sequence - right.sequence);
    if (planCalls.length < 2)
      return fail("plan_updates", "Expected a plan before work and a final completed plan.", "behavior");
    const payloads = planCalls.map(planPayload);
    if (payloads.some((payload) => !payload || !validInProgressState(payload)))
      return fail("in_progress", "Every unresolved plan payload must have exactly one in-progress step.", "behavior");
    const firstMutation = input.toolCalls
      .filter((call) => isMutation(call))
      .sort((left, right) => left.sequence - right.sequence)[0];
    if (!firstMutation || planCalls[0]!.sequence >= firstMutation.sequence)
      return fail("plan_before_mutation", "A successful plan must precede the first mutating call.", "behavior");
    for (const path of ["inputs/base.txt", "inputs/suffixes.txt"]) {
      const read = input.toolCalls.find(
        (call) => call.name === "read" && call.outcome === "success" && toolPath(call.input).endsWith(path),
      );
      if (!read || read.sequence >= firstMutation.sequence)
        return fail("input_discovery", `The hidden fixture input ${path} was not read before mutation.`, "behavior");
    }
    const finalPlan = payloads.at(-1)!;
    if (finalPlan.steps.length === 0 || finalPlan.steps.some((step) => !["done", "cancelled"].includes(step.status)))
      return fail("incomplete", "Every final plan step must be resolved.", "behavior");
    const writes = input.toolCalls
      .filter((call) => call.capability === "write" && call.outcome === "success")
      .sort((left, right) => left.sequence - right.sequence);
    const orderedWrites: RuntimeToolTrace[] = [];
    for (const path of OUTPUT_PATHS) {
      const matches = writes.filter((call) => toolPath(call.input).endsWith(path));
      if (matches.length === 0) return fail("write_count", `Expected a successful write for ${path}.`, "semantic_goal");
      orderedWrites.push(matches[0]!);
    }
    if (orderedWrites.some((call, index) => index > 0 && call.sequence <= orderedWrites[index - 1]!.sequence))
      return fail("write_order", "The three generated files were not written in dependency order.", "behavior");
    const testCall = input.toolCalls.findLast(
      (call) =>
        call.name === "bash" &&
        command(call.input) === "bun test" &&
        call.outcome === "success" &&
        commandExitCode(call.output) === 0,
    );
    const lastWriteSequence = Math.max(...orderedWrites.map((call) => call.sequence));
    if (!testCall || testCall.sequence <= lastWriteSequence || planCalls.at(-1)!.sequence <= testCall.sequence)
      return fail(
        "verify_progress",
        "Passing verification and the final resolved plan must follow all writes.",
        "behavior",
      );
    if (
      planCalls.slice(0, -1).some((call) => {
        const payload = planPayload(call);
        return payload?.steps.every((step) => ["done", "cancelled"].includes(step.status));
      })
    )
      return fail("premature_completion", "The plan was marked complete before final verification.", "behavior");
    if (input.verifier?.timedOut)
      return fail("verifier_timeout", "Independent pipeline verification timed out.", "harness_terminal");
    if (input.verifier?.exitCode !== 0)
      return fail("verifier", "Independent pipeline verification failed.", "semantic_goal");
    for (const path of OUTPUT_PATHS) {
      if (input.workspace.final.entries.find((entry) => entry.path === path)?.sha256 !== input.world.outputHashes[path])
        return fail("output", `The exact output hash was wrong for ${path}.`, "format_contract");
    }
    return { passed: true };
  },
};

interface ParsedPlan {
  steps: Array<{ text: string; status: string }>;
}

function planPayload(call: RuntimeToolTrace): ParsedPlan | undefined {
  if (!isRecord(call.input) || !Array.isArray(call.input.steps)) return undefined;
  const steps: ParsedPlan["steps"] = [];
  for (const raw of call.input.steps) {
    if (!isRecord(raw) || typeof raw.text !== "string" || typeof raw.status !== "string") return undefined;
    steps.push({ text: raw.text, status: raw.status });
  }
  return { steps };
}

function validInProgressState(payload: ParsedPlan): boolean {
  if (
    payload.steps.length === 0 ||
    payload.steps.some((step) => !["pending", "in_progress", "done", "cancelled"].includes(step.status))
  )
    return false;
  const unresolved = payload.steps.filter((step) => step.status === "pending" || step.status === "in_progress");
  const inProgress = payload.steps.filter((step) => step.status === "in_progress");
  return inProgress.length <= 1 && (unresolved.length === 0 || inProgress.length === 1);
}

function isMutation(call: RuntimeToolTrace): boolean {
  return call.outcome === "success" && call.capability === "write";
}

function toolPath(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value.file_path === "string") return value.file_path;
  const patch = value.patch;
  if (typeof patch === "string") {
    return OUTPUT_PATHS.find((path) => patch.includes(path)) ?? "";
  }
  return "";
}

function command(value: unknown): string | undefined {
  return isRecord(value) && typeof value.command === "string" ? value.command.trim() : undefined;
}

function commandExitCode(value: unknown): number | undefined {
  if (!isRecord(value) || !isRecord(value.metadata)) return undefined;
  return typeof value.metadata.exitCode === "number" ? value.metadata.exitCode : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `plan_progress.${code}`, message, dimension };
}
