// @summary Runtime eval for nested AGENTS.md instruction hierarchy compliance

import type { RuntimeEvalTask } from "../../runtime-task";
import type { EvalDimension } from "../../task";
import {
  createFixtureRuntimeConfigForCwd,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  verifyExactFiles,
  writeFixture,
} from "./helpers";

export interface InstructionHierarchyWorld extends RuntimeFixtureWorld {
  cwd: string;
  target: string;
  rootMarker: string;
  nestedMarker: string;
  expectedHash: string;
}

const TARGET_PATH = "nested/project/target.txt";
const RESULT_PATH = "nested/project/RESULT.txt";

export const instructionHierarchyTask: RuntimeEvalTask<InstructionHierarchyWorld> = {
  id: "instruction-hierarchy",
  description: "Apply independently seeded root and nested project instructions from a nested runtime cwd.",
  fixtureVersion: "instruction-hierarchy-v1",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 5, maxToolCalls: 3, timeoutMs: 180_000 },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["read", "write", "edit", "multi_edit", "apply_patch"],
    allowedCapabilities: ["read", "write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const target = seededToken(seed, "PAYLOAD");
    const rootMarker = seededToken(seed, "ROOT_RULE");
    const nestedMarker = seededToken(seed, "NESTED_RULE");
    const expected = `${rootMarker}[${target}]${nestedMarker}\n`;
    await writeFixture(root, {
      ".git/.keep": "fixture boundary\n",
      "AGENTS.md": `For RESULT.txt, wrap the exact target payload as ${rootMarker}[PAYLOAD]. Preserve all instruction files.\n`,
      "nested/project/AGENTS.md": `For RESULT.txt, append ${nestedMarker} immediately after the root transformation and finish with one newline.\n`,
      [TARGET_PATH]: `${target}\n`,
    });
    return {
      root,
      seed,
      cwd: `${root}/nested/project`,
      target,
      rootMarker,
      nestedMarker,
      expected,
      expectedHash: sha256Text(expected),
      protectedPaths: [".git/.keep", "AGENTS.md", "nested/project/AGENTS.md", TARGET_PATH],
      allowedChanges: [RESULT_PATH],
    };
  },
  resolveThreadCwd: (world) => world.cwd,
  createRuntimeConfig: (world, profile) => createFixtureRuntimeConfigForCwd(world, profile, world.cwd),
  createSteps: () => [
    {
      kind: "turn",
      mode: "execute",
      message:
        "Inspect target.txt exactly once and create RESULT.txt by following every applicable project instruction. Do not modify the target or instruction files.",
    },
  ],
  verify: (world, signal) => verifyExactFiles(world, { [RESULT_PATH]: world.expected }, signal),
  snapshotWorld: async (world) => ({ result: await exactFile(world.root, RESULT_PATH) }),
  evaluate(input) {
    const reads = input.toolCalls.filter((call) => call.name === "read" && call.outcome === "success");
    if (reads.length !== 1 || !toolPath(reads[0]!.input).endsWith(TARGET_PATH))
      return fail("target_read", "The model must read only the nested target file exactly once.", "runtime_policy");
    if (input.verifier?.timedOut)
      return fail("verifier_timeout", "Independent exact-file verification timed out.", "harness_terminal");
    if (input.verifier?.exitCode !== 0)
      return fail("verifier", "Independent exact-file verification failed.", "semantic_goal");
    const result = input.workspace.final.entries.find((entry) => entry.path === RESULT_PATH);
    return result?.sha256 === input.world.expectedHash
      ? { passed: true }
      : fail(
          "wrong_result",
          "RESULT.txt did not combine both hidden instruction transformations exactly.",
          "format_contract",
        );
  },
};

function toolPath(value: unknown): string {
  return isRecord(value) && typeof value.file_path === "string" ? value.file_path : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `instruction_hierarchy.${code}`, message, dimension };
}
