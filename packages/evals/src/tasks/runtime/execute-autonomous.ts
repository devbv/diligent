// @summary Runtime eval for autonomous execute-mode repair and verification without clarification

import type { RuntimeEvalTask } from "../../runtime-task";
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

export interface ExecuteAutonomousWorld extends RuntimeFixtureWorld {
  marker: string;
  operand: number;
  expectedHash: string;
}

const SOURCE_PATH = "src/transform.ts";

export const executeAutonomousTask: RuntimeEvalTask<ExecuteAutonomousWorld> = {
  id: "execute-autonomous",
  description: "Repair and independently verify a fully specified project directly in execute mode.",
  fixtureVersion: "execute-autonomous-v3",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 11, maxToolCalls: 10, timeoutMs: 240_000 },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["read", "write", "edit", "multi_edit", "apply_patch", "bash"],
    allowedCapabilities: ["read", "write", "execute"],
    allowedCommands: ["bun test"],
  },
  async setup(seed, root) {
    const marker = seededToken(seed, "EXECUTE");
    const operand = (Number.parseInt(seed.slice(0, 5), 36) % 11) + 3;
    const expected = `// ${marker}\nexport function transform(value: number): number {\n  return value * ${operand};\n}\n`;
    await writeFixture(root, {
      ".git/.keep": "fixture boundary\n",
      "AGENTS.md": "Keep tests and package metadata unchanged. Verify the repair with exactly `bun test`.\n",
      "package.json": `${JSON.stringify({ scripts: { test: "bun test test/transform.test.ts" } }, null, 2)}\n`,
      [SOURCE_PATH]: `// ${marker}\nexport function transform(value: number): number {\n  return value + ${operand};\n}\n`,
      "test/transform.test.ts": `import { expect, test } from "bun:test";\nimport { transform } from "../src/transform";\ntest("seeded transform", () => expect(transform(4)).toBe(${4 * operand}));\n`,
    });
    return {
      root,
      seed,
      marker,
      operand,
      expected,
      expectedHash: sha256Text(expected),
      protectedPaths: [".git/.keep", "AGENTS.md", "package.json", "test/transform.test.ts"],
      allowedChanges: [SOURCE_PATH],
    };
  },
  createRuntimeConfig: createIsolatedFixtureRuntimeConfig,
  createSteps: () => [
    {
      kind: "turn",
      mode: "execute",
      message:
        "Diagnose and repair src/transform.ts against test/transform.test.ts completely. Follow the project instructions, preserve tests and metadata, and verify the finished repair. Work autonomously without asking for clarification.",
    },
  ],
  verify: (world, signal) => runVerifier(world, ["bun", "test"], signal),
  snapshotWorld: async (world) => ({ source: await exactFile(world.root, SOURCE_PATH) }),
  evaluate(input) {
    if (input.userInputRequests.length > 0 || input.toolCalls.some((call) => call.name === "request_user_input"))
      return fail("question", "Autonomous execution must not request user input.", "behavior");
    if (input.toolCalls.some((call) => call.name === "plan") || lastAssistantText(input).includes("<proposed_plan>"))
      return fail("stopped_at_plan", "Execute mode must implement the repair rather than stop at a plan.", "behavior");
    const lastWrite = input.toolCalls
      .filter((call) => call.capability === "write" && call.outcome === "success")
      .sort((left, right) => left.sequence - right.sequence)
      .at(-1);
    if (!lastWrite) return fail("write", "No implementation mutation succeeded.", "behavior");
    if (
      !input.toolCalls.some(
        (call) =>
          call.name === "bash" &&
          command(call.input) === "bun test" &&
          call.outcome === "success" &&
          commandExitCode(call.output) === 0 &&
          call.sequence > lastWrite.sequence,
      )
    )
      return fail(
        "test",
        "The exact project verification command did not exit zero after the final mutation.",
        "behavior",
      );
    if (input.verifier?.timedOut)
      return fail("verifier_timeout", "Independent test verification timed out.", "harness_terminal");
    if (input.verifier?.exitCode !== 0)
      return fail("verifier", "Independent test verification failed.", "semantic_goal");
    const source = input.workspace.final.entries.find((entry) => entry.path === SOURCE_PATH);
    return source?.sha256 === input.world.expectedHash
      ? { passed: true }
      : fail("source", "The repaired source hash did not match the seeded expected implementation.", "semantic_goal");
  },
};

function lastAssistantText(input: Parameters<typeof executeAutonomousTask.evaluate>[0]): string {
  const message = input.turns
    .at(-1)
    ?.messages.filter((item) => item.role === "assistant")
    .at(-1);
  return (
    message?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("") ?? ""
  );
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
  return { passed: false as const, code: `execute_autonomous.${code}`, message, dimension };
}
