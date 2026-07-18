// @summary Runtime eval fixture for plan-mode read-only diagnosis

import type { RuntimeEvalTask } from "../../runtime-task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  type RuntimeFixtureWorld,
  seededToken,
  writeFixture,
} from "./helpers";

interface PlanWorld extends RuntimeFixtureWorld {
  token: string;
  cause: string;
}
export const planReadonlyTask: RuntimeEvalTask<PlanWorld> = {
  id: "plan-readonly",
  description: "Diagnose a seeded defect without mutating the workspace.",
  fixtureVersion: "plan-readonly-v0",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 8, maxToolCalls: 12, timeoutMs: 180_000 },
  toolPolicy: {
    allowedTools: ["read", "grep", "glob", "ls"],
    allowedCapabilities: ["read"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const token = seededToken(seed, "TOKEN");
    const cause = "WRONG_COMPARATOR";
    await writeFixture(root, {
      "src/check.ts": `// ${token}\nexport const accepts = (value: number) => value < 10;\n`,
      "test/check.test.ts": `import { expect, test } from "bun:test";\nimport { accepts } from "../src/check";\ntest("boundary", () => expect(accepts(10), "${cause}").toBe(true));\n`,
    });
    return {
      root,
      seed,
      token,
      cause,
      expected: `CAUSE=${cause}; TOKEN=${token}`,
      protectedPaths: ["src/check.ts", "test/check.test.ts"],
      allowedChanges: [],
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: (world) => [
    {
      kind: "turn",
      mode: "plan",
      message: `Diagnose only by inspecting src/check.ts and test/check.test.ts; make no changes. Your entire response must be exactly one line with no explanation, preamble, or code fence: CAUSE=<identifier>; TOKEN=${world.token}. The cause identifier is the failing assertion's defect category.`,
    },
  ],
  snapshotWorld: async (world) => ({ token: world.token, cause: world.cause }),
  evaluate(input) {
    if (!input.toolCalls.some((call) => call.capability === "read"))
      return { passed: false, code: "plan_readonly.no_read", message: "No read capability was used." };
    if (input.toolCalls.some((call) => call.capability !== "read"))
      return { passed: false, code: "plan_readonly.mutation", message: "A non-read capability was used." };
    const last = input.turns
      .at(-1)
      ?.messages.filter((message) => message.role === "assistant")
      .at(-1);
    const text = last
      ? last.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("")
          .trim()
      : "";
    return text === input.world.expected
      ? { passed: true }
      : { passed: false, code: "plan_readonly.wrong_answer", message: `Expected ${input.world.expected}.` };
  },
};
