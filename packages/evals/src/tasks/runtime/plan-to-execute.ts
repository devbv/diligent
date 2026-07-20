// @summary Runtime eval for carrying an opaque diagnosis across a plan-to-execute transition

import { unlink } from "node:fs/promises";
import type { RuntimeEvalTask, RuntimeToolTrace } from "../../runtime-task";
import type { EvalDimension } from "../../task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  writeFixture,
} from "./helpers";

export interface PlanToExecuteWorld extends RuntimeFixtureWorld {
  token: string;
  multiplier: number;
  offset: number;
  diagnosisPath: string;
}

const SOURCE_PATH = "src/value.ts";
const DIAGNOSIS_PATH = "spec/private-contract.txt";

export const planToExecuteTask: RuntimeEvalTask<PlanToExecuteWorld> = {
  id: "plan-to-execute",
  description: "Persist an opaque read-only diagnosis and implement it after its source is withdrawn.",
  fixtureVersion: "plan-to-execute-v3",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 14, maxToolCalls: 20, timeoutMs: 300_000 },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["read", "grep", "glob", "ls", "write", "edit", "multi_edit", "apply_patch", "bash"],
    allowedCapabilities: ["read", "write", "execute"],
    allowedCommands: ["bun test"],
  },
  async setup(seed, root) {
    const token = seededToken(seed, "CONTRACT");
    const multiplier = (Number.parseInt(seed.slice(0, 4), 36) % 5) + 2;
    const offset = (Number.parseInt(seed.slice(4, 8), 36) % 13) + 1;
    await writeFixture(root, {
      "package.json": `${JSON.stringify({ scripts: { test: "bun test test/value.test.ts" } }, null, 2)}\n`,
      [SOURCE_PATH]: "export function adjustValue(value: number): number {\n  return value;\n}\n",
      [DIAGNOSIS_PATH]: [
        `Contract id: ${token}`,
        `Required behavior: return value * ${multiplier} + ${offset}.`,
        "The implementation must remain a pure number-to-number function.",
        "",
      ].join("\n"),
      "test/value.test.ts": [
        'import { expect, test } from "bun:test";',
        'import { adjustValue } from "../src/value";',
        'test("returns a finite number", () => expect(Number.isFinite(adjustValue(2))).toBe(true));',
        "",
      ].join("\n"),
      "AGENTS.md": "Do not modify tests or package metadata. Verify implementation changes with exactly `bun test`.\n",
    });
    return {
      root,
      seed,
      token,
      multiplier,
      offset,
      diagnosisPath: DIAGNOSIS_PATH,
      expected: "",
      protectedPaths: ["test/value.test.ts", "AGENTS.md", "package.json"],
      allowedChanges: [SOURCE_PATH, DIAGNOSIS_PATH],
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: () => [
    {
      kind: "turn",
      mode: "plan",
      message:
        "Investigate the incomplete value transformation against the project specification. Produce a concrete implementation plan that preserves every contract detail. Do not change files or run commands.",
    },
    {
      kind: "turn",
      mode: "default",
      message:
        "The specification source has now been withdrawn. Implement the diagnosis retained in your plan, preserve tests and metadata, and verify with `bun test`.",
    },
  ],
  async prepareStep(world, _step, index) {
    if (index === 1) await unlink(`${world.root}/${world.diagnosisPath}`);
  },
  async verify(world, signal) {
    const started = performance.now();
    const expression =
      `import { adjustValue } from ${JSON.stringify(`${world.root}/${SOURCE_PATH}`)}; ` +
      `if (adjustValue(7) !== ${7 * world.multiplier + world.offset} || ` +
      `adjustValue(-3) !== ${-3 * world.multiplier + world.offset}) process.exit(1);`;
    const verifierProcess = Bun.spawn([process.execPath, "-e", expression], {
      cwd: world.root,
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
    const exitCode = await verifierProcess.exited;
    return {
      argv: ["hidden-contract-verifier"],
      exitCode,
      elapsedMs: Math.round(performance.now() - started),
      stdout: (await new Response(verifierProcess.stdout).text()).slice(0, 16_384),
      stderr: (await new Response(verifierProcess.stderr).text()).slice(0, 16_384),
      timedOut: signal.aborted,
    };
  },
  snapshotWorld: async (world) => ({ source: await exactFile(world.root, SOURCE_PATH) }),
  evaluate(input) {
    const firstTurnIds = new Set(
      input.turns[0]!.coreEvents.flatMap(({ event }) => (event.type === "tool_start" ? [event.toolCallId] : [])),
    );
    const firstTurnCalls = input.toolCalls.filter((call) => firstTurnIds.has(call.toolCallId));
    if (firstTurnCalls.some((call) => !["read", "grep", "glob", "ls"].includes(call.name)))
      return fail("plan_mutation", "The planning turn used a non-read tool.", "runtime_policy");
    if (!firstTurnCalls.some((call) => call.name === "read" && toolPath(call.input).endsWith(DIAGNOSIS_PATH)))
      return fail("diagnosis", "The planning turn did not inspect the private contract.", "behavior");
    const planText = lastAssistantText(input.turns[0]!.messages);
    if (
      !planText.includes(input.world.token) ||
      !planText.includes(String(input.world.multiplier)) ||
      !planText.includes(String(input.world.offset))
    )
      return fail("plan_context", "The plan did not retain every opaque contract detail.", "semantic_goal");
    const writes = input.toolCalls.filter((call) => call.capability === "write" && call.outcome === "success");
    if (writes.length === 0) return fail("no_write", "No implementation write succeeded.", "behavior");
    const passingTest = input.toolCalls.filter(isPassingBunTest).at(-1);
    if (!passingTest || passingTest.sequence <= Math.max(...writes.map((call) => call.sequence)))
      return fail("no_test", "The final implementation was not followed by a passing bun test.", "behavior");
    if (input.verifier?.timedOut)
      return fail("verifier_timeout", "Hidden contract verification timed out.", "harness_terminal");
    return input.verifier?.exitCode === 0
      ? { passed: true }
      : fail("contract", "The implementation did not satisfy the retained private contract.", "semantic_goal");
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

function lastAssistantText(messages: import("@diligent/core/message-contract").Message[]): string {
  const last = messages.filter((message) => message.role === "assistant").at(-1);
  return (
    last?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("") ?? ""
  );
}

function toolPath(value: unknown): string {
  return isRecord(value) && typeof value.file_path === "string" ? value.file_path : "";
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
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `plan_to_execute.${code}`, message, dimension };
}
