// @summary Runtime eval fixture for instruction-guided diagnosis, editing, and verification

import type { RuntimeEvalTask, RuntimeToolTrace } from "../../runtime-task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  runVerifier,
  sha256Text,
  writeFixture,
} from "./helpers";

interface ProjectFixWorld extends RuntimeFixtureWorld {
  operand: number;
  expectedHash: string;
}

export const projectFixTask: RuntimeEvalTask<ProjectFixWorld> = {
  id: "project-fix",
  description: "Fix a seeded TypeScript defect and verify it with the declared command.",
  fixtureVersion: "project-fix-v1",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 16, maxToolCalls: 24, timeoutMs: 300_000 },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["read", "grep", "glob", "ls", "write", "edit", "multi_edit", "apply_patch", "bash"],
    allowedCapabilities: ["read", "write", "execute"],
    allowedCommands: ["bun test"],
  },
  async setup(seed, root) {
    const operand = (Number.parseInt(seed.slice(0, 4), 36) % 7) + 2;
    await writeFixture(root, {
      "package.json": `${JSON.stringify({ scripts: { test: "bun test test/value.test.ts" } }, null, 2)}\n`,
      "src/value.ts": `export function addSeed(value: number): number {\n  return value - ${operand};\n}\n`,
      "test/value.test.ts": `import { expect, test } from "bun:test";\nimport { addSeed } from "../src/value";\ntest("adds", () => expect(addSeed(10)).toBe(${10 + operand}));\n`,
      "AGENTS.md": "Do not modify tests or package metadata. Verify the fix with exactly `bun test`.\n",
    });
    const expectedSource = `export function addSeed(value: number): number {\n  return value + ${operand};\n}\n`;
    return {
      root,
      seed,
      operand,
      expected: expectedSource,
      expectedHash: sha256Text(expectedSource),
      protectedPaths: ["test/value.test.ts", "AGENTS.md", "package.json"],
      allowedChanges: ["src/value.ts"],
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: () => [
    {
      kind: "turn",
      message:
        "Diagnose and fix the failing behavior. Follow project instructions and verify the result. Use dedicated read/search tools for inspection; the only allowed shell command is exactly `bun test`.",
    },
  ],
  verify: (world, signal) => runVerifier(world, ["bun", "test"], signal),
  snapshotWorld: async (world) => ({ operand: world.operand, source: await exactFile(world.root, "src/value.ts") }),
  evaluate(input) {
    const world = input.world;
    const source = input.workspace.final.entries.find((entry) => entry.path === "src/value.ts");
    const changed = input.workspace.initial.entries.find((entry) => entry.path === "src/value.ts");
    if (!input.toolCalls.some((call) => call.capability === "read"))
      return {
        passed: false,
        code: "project_fix.no_read",
        message: "No read capability was used.",
        dimension: "behavior",
      };
    const writes = input.toolCalls.filter((call) => call.capability === "write" && call.outcome === "success");
    if (writes.length === 0)
      return {
        passed: false,
        code: "project_fix.no_write",
        message: "No write capability succeeded.",
        dimension: "behavior",
      };
    const passingTest = input.toolCalls
      .filter(isPassingBunTest)
      .sort((left, right) => left.sequence - right.sequence)
      .at(-1);
    if (!passingTest)
      return {
        passed: false,
        code: "project_fix.no_test",
        message: "No exact successful bun test command with zero-exit evidence was recorded.",
        dimension: "behavior",
      };
    if (passingTest.sequence <= Math.max(...writes.map((call) => call.sequence)))
      return {
        passed: false,
        code: "project_fix.test_order",
        message: "The final successful write was not followed by an exact passing bun test command.",
        dimension: "behavior",
      };
    if (input.verifier?.timedOut)
      return {
        passed: false,
        code: "project_fix.test_failed",
        message: "Independent verifier timed out.",
        dimension: "harness_terminal",
      };
    if (input.verifier?.exitCode !== 0)
      return {
        passed: false,
        code: "project_fix.test_failed",
        message: "Independent verifier failed.",
        dimension: "semantic_goal",
      };
    if (source?.sha256 === changed?.sha256 || source?.sha256 !== world.expectedHash)
      return {
        passed: false,
        code: "project_fix.wrong_source",
        message: "The source does not match the expected semantic fix.",
        dimension: "semantic_goal",
      };
    return { passed: true };
  },
};

function isPassingBunTest(call: RuntimeToolTrace): boolean {
  return (
    call.name === "bash" &&
    commandOf(call.input) === "bun test" &&
    call.outcome === "success" &&
    exitCodeOf(call.output) === 0
  );
}

function commandOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value.command === "string" ? value.command.trim() : undefined;
}

function exitCodeOf(value: unknown): number | undefined {
  return isRecord(value) && isRecord(value.metadata) && typeof value.metadata.exitCode === "number"
    ? value.metadata.exitCode
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
