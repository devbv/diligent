// @summary Runtime eval candidate for plan-to-default mode transition and context handoff

import type { RuntimeEvalTask } from "../../runtime-task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  runVerifier,
  seededToken,
  sha256Text,
  writeFixture,
} from "./helpers";

export interface PlanToExecuteWorld extends RuntimeFixtureWorld {
  token: string;
  operand: number;
  planAnswer: string;
  expectedHash: string;
}

const READ_TOOLS = new Set(["read", "grep", "glob", "ls"]);

export const planToExecuteTask: RuntimeEvalTask<PlanToExecuteWorld> = {
  id: "plan-to-execute",
  description: "Carry a read-only diagnosis across a plan-to-default mode transition and implement it.",
  fixtureVersion: "plan-to-execute-v1",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 16, maxToolCalls: 24, timeoutMs: 300_000 },
  toolPolicy: {
    allowedTools: ["read", "grep", "glob", "ls", "write", "edit", "multi_edit", "apply_patch", "bash"],
    allowedCapabilities: ["read", "write", "execute"],
    allowedCommands: ["bun test"],
  },
  async setup(seed, root) {
    const token = seededToken(seed, "PLAN");
    const operand = (Number.parseInt(seed.slice(0, 4), 36) % 7) + 2;
    const planAnswer = `FIX=WRONG_OPERATOR; TOKEN=${token}`;
    const initialSource = `// ${token}\nexport function adjustValue(value: number): number {\n  return value - ${operand};\n}\n`;
    const expected = `// ${token}\nexport function adjustValue(value: number): number {\n  return value + ${operand};\n}\n`;
    await writeFixture(root, {
      "package.json": `${JSON.stringify({ scripts: { test: "bun test test/value.test.ts" } }, null, 2)}\n`,
      "src/value.ts": initialSource,
      "test/value.test.ts": `import { expect, test } from "bun:test";\nimport { adjustValue } from "../src/value";\ntest("adjusts", () => expect(adjustValue(10), "WRONG_OPERATOR").toBe(${10 + operand}));\n`,
      "AGENTS.md": "Do not modify tests or package metadata. Verify implementation changes with exactly `bun test`.\n",
    });
    return {
      root,
      seed,
      token,
      operand,
      planAnswer,
      expected,
      expectedHash: sha256Text(expected),
      protectedPaths: ["test/value.test.ts", "AGENTS.md", "package.json"],
      allowedChanges: ["src/value.ts"],
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: (world) => [
    {
      kind: "turn",
      mode: "plan",
      message: `You must call read on both src/value.ts and test/value.test.ts before answering. Diagnose the defect without changing files or running commands. The cause identifier is the exact diagnostic string inside the failing assertion and is not stated in this request. Reply with exactly one line using the format FIX=CAUSE_ID; TOKEN=${world.token}, replacing CAUSE_ID with the diagnostic string you read. Never output CAUSE_ID literally.`,
    },
    {
      kind: "turn",
      mode: "default",
      message:
        "Implement the diagnosis from the previous turn. Follow AGENTS.md, keep tests and metadata unchanged, and verify with exactly `bun test`.",
    },
  ],
  verify: (world, signal) => runVerifier(world, ["bun", "test"], signal),
  snapshotWorld: async (world) => ({
    token: world.token,
    operand: world.operand,
    source: await exactFile(world.root, "src/value.ts"),
  }),
  evaluate(input) {
    if (input.turns.length !== 2)
      return { passed: false, code: "plan_to_execute.turn_count", message: "Expected two completed turns." };
    const firstTurnTools = input.turns[0]!.coreEvents.filter((item) => item.event.type === "tool_start").map(
      (item) => (item.event as { toolName: string }).toolName,
    );
    if (!firstTurnTools.some((name) => READ_TOOLS.has(name)))
      return {
        passed: false,
        code: "plan_to_execute.no_plan_read",
        message: "The plan turn did not inspect the fixture.",
      };
    if (firstTurnTools.some((name) => !READ_TOOLS.has(name)))
      return {
        passed: false,
        code: "plan_to_execute.plan_mutation",
        message: "The plan turn used a non-read tool.",
      };
    if (lastAssistantText(input.turns[0]!.messages) !== input.world.planAnswer)
      return {
        passed: false,
        code: "plan_to_execute.wrong_plan",
        message: `Expected ${input.world.planAnswer}.`,
      };
    if (!input.session.lines.some((line) => isRecord(line) && line.type === "mode_change" && line.mode === "default"))
      return {
        passed: false,
        code: "plan_to_execute.mode_change",
        message: "The default-mode transition was not persisted.",
      };
    if (!input.toolCalls.some((call) => call.capability === "write" && !call.error))
      return { passed: false, code: "plan_to_execute.no_write", message: "No implementation write succeeded." };
    if (!input.toolCalls.some((call) => call.name === "bash" && commandOf(call.input) === "bun test" && !call.error))
      return { passed: false, code: "plan_to_execute.no_test", message: "The exact test command was not recorded." };
    if (input.verifier?.exitCode !== 0)
      return { passed: false, code: "plan_to_execute.test_failed", message: "Independent verifier failed." };
    const source = input.workspace.final.entries.find((entry) => entry.path === "src/value.ts");
    if (source?.sha256 !== input.world.expectedHash)
      return {
        passed: false,
        code: "plan_to_execute.wrong_source",
        message: "The source does not match the expected implementation.",
      };
    return { passed: true };
  },
};

function lastAssistantText(messages: import("@diligent/core/message-contract").Message[]): string {
  const last = messages.filter((message) => message.role === "assistant").at(-1);
  if (!last) return "";
  return last.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function commandOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value.command === "string" ? value.command.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
