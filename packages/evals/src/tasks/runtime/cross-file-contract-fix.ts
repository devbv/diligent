// @summary Runtime eval for an autonomous parser-caller contract repair verified by behavior

import type { RuntimeEvalTask, RuntimeToolTrace } from "../../runtime-task";
import type { EvalDimension } from "../../task";
import {
  createIsolatedFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  runVerifier,
  seededToken,
  writeFixture,
} from "./helpers";

export interface CrossFileContractFixWorld extends RuntimeFixtureWorld {
  marker: string;
}

const PARSER_PATH = "src/parse-duration.ts";
const CALLER_PATH = "src/retry-config.ts";

export const crossFileContractFixTask: RuntimeEvalTask<CrossFileContractFixWorld> = {
  id: "cross-file-contract-fix",
  description: "Repair a parser and its caller while preserving the tested public contract.",
  fixtureVersion: "cross-file-contract-fix-v2",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 14, maxToolCalls: 18, timeoutMs: 300_000 },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["read", "grep", "glob", "ls", "write", "edit", "multi_edit", "apply_patch", "bash"],
    allowedCapabilities: ["read", "write", "execute"],
    allowedCommands: ["bun test"],
  },
  async setup(seed, root) {
    const marker = seededToken(seed, "RETRY_CONTRACT");
    await writeFixture(root, {
      ".git/.keep": "fixture boundary\n",
      "AGENTS.md":
        "Preserve public exports, tests, and package metadata. Verify the complete repair with `bun test`.\n",
      "package.json": `${JSON.stringify({ scripts: { test: "bun test test/retry-config.test.ts" } }, null, 2)}\n`,
      [PARSER_PATH]: [
        `// ${marker}`,
        "export function parseDuration(value: string): number {",
        '  if (!/^\\d+s$/.test(value)) throw new Error("duration must use whole seconds");',
        "  return Number(value.slice(0, -1));",
        "}",
        "",
      ].join("\n"),
      [CALLER_PATH]: [
        'import { parseDuration } from "./parse-duration";',
        "",
        "export interface RetryConfig { delayMs: number; attempts: number }",
        "export function loadRetryConfig(raw: { retryDelay: string; attempts: number }): RetryConfig {",
        "  return { delayMs: parseDuration(String(raw.attempts)), attempts: 1 };",
        "}",
        "",
      ].join("\n"),
      "test/retry-config.test.ts": [
        'import { expect, test } from "bun:test";',
        'import { parseDuration } from "../src/parse-duration";',
        'import { loadRetryConfig } from "../src/retry-config";',
        'test("duration uses milliseconds", () => expect(parseDuration("3s")).toBe(3000));',
        'test("caller maps both fields", () =>',
        '  expect(loadRetryConfig({ retryDelay: "5s", attempts: 4 })).toEqual({ delayMs: 5000, attempts: 4 }));',
        "",
      ].join("\n"),
    });
    return {
      root,
      seed,
      marker,
      expected: "",
      protectedPaths: [".git/.keep", "AGENTS.md", "package.json", "test/retry-config.test.ts"],
      allowedChanges: [PARSER_PATH, CALLER_PATH],
    };
  },
  createRuntimeConfig: createIsolatedFixtureRuntimeConfig,
  createSteps: () => [
    {
      kind: "turn",
      mode: "execute",
      message:
        "Diagnose and fix the retry configuration behavior. There are independent defects in both implementation " +
        "files, so inspect and repair both while preserving the public API and protected files. Verify the complete " +
        "repair with the project test suite; do not stop after a failing test run, and continue until it passes.",
    },
  ],
  verify: (world, signal) => runVerifier(world, ["bun", "test"], signal),
  snapshotWorld: async (world) => ({
    parser: await exactFile(world.root, PARSER_PATH),
    caller: await exactFile(world.root, CALLER_PATH),
  }),
  evaluate(input) {
    const writes = input.toolCalls.filter((call) => call.capability === "write" && call.outcome === "success");
    if (writes.length === 0) return fail("write", "No implementation mutation succeeded.", "behavior");
    const passingTest = input.toolCalls.filter(isPassingBunTest).at(-1);
    if (!passingTest || passingTest.sequence <= Math.max(...writes.map((call) => call.sequence)))
      return fail("test", "The final mutation was not followed by a passing project test.", "behavior");
    if (input.verifier?.timedOut)
      return fail("verifier_timeout", "Independent test verification timed out.", "harness_terminal");
    return input.verifier?.exitCode === 0
      ? { passed: true }
      : fail("contract", "The parser-caller public contract still fails.", "semantic_goal");
  },
};

function isPassingBunTest(call: RuntimeToolTrace): boolean {
  return (
    call.name === "bash" &&
    command(call.input) === "bun test" &&
    call.outcome === "success" &&
    commandExitCode(call.output) === 0
  );
}

function command(value: unknown): string | undefined {
  return isRecord(value) && typeof value.command === "string" ? value.command.trim() : undefined;
}

function commandExitCode(value: unknown): number | undefined {
  return isRecord(value) && isRecord(value.metadata) && typeof value.metadata.exitCode === "number"
    ? value.metadata.exitCode
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `cross_file_contract_fix.${code}`, message, dimension };
}
