// @summary Runtime eval fixture for project skill discovery and reference-guided mutation

import type { RuntimeEvalTask } from "../../runtime-task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  writeFixture,
} from "./helpers";

interface SkillWorld extends RuntimeFixtureWorld {
  token: string;
  expectedHash: string;
}
export const skillGuidedChangeTask: RuntimeEvalTask<SkillWorld> = {
  id: "skill-guided-change",
  description: "Use a task-local skill and its relative reference to create an exact result.",
  fixtureVersion: "skill-guided-change-v0",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 8, maxToolCalls: 10, timeoutMs: 240_000 },
  toolPolicy: {
    allowedTools: ["skill", "read", "write", "edit", "multi_edit", "apply_patch"],
    allowedCapabilities: ["read", "write", "skill"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const token = seededToken(seed, "RESULT");
    await writeFixture(root, {
      ".diligent/skills/seeded-transform/SKILL.md":
        "---\nname: seeded-transform\ndescription: Apply the seeded fixture rule.\n---\nRead `references/rule.txt`, then write its exact content plus one newline to `RESULT.txt`.\n",
      ".diligent/skills/seeded-transform/references/rule.txt": token,
      "INPUT.txt": "transform this input\n",
    });
    return {
      root,
      seed,
      token,
      expected: `${token}\n`,
      expectedHash: sha256Text(`${token}\n`),
      protectedPaths: [
        "INPUT.txt",
        ".diligent/skills/seeded-transform/SKILL.md",
        ".diligent/skills/seeded-transform/references/rule.txt",
      ],
      allowedChanges: ["RESULT.txt"],
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: () => [{ kind: "turn", message: "/seeded-transform transform INPUT.txt according to the skill" }],
  snapshotWorld: async (world) => ({ token: world.token, result: await exactFile(world.root, "RESULT.txt") }),
  evaluate(input) {
    const first = input.toolCalls[0];
    if (first?.name !== "skill" || !JSON.stringify(first.input).includes("seeded-transform"))
      return {
        passed: false,
        code: "skill_guided_change.skill_not_first",
        message: "The skill tool was not the first procedural call.",
      };
    if (input.toolCalls.some((call) => ["execute", "collab", "knowledge", "user_input"].includes(call.capability)))
      return {
        passed: false,
        code: "skill_guided_change.forbidden_capability",
        message: "A forbidden capability was used.",
      };
    const result = input.workspace.final.entries.find((entry) => entry.path === "RESULT.txt");
    return result?.sha256 === input.world.expectedHash
      ? { passed: true }
      : {
          passed: false,
          code: "skill_guided_change.wrong_result",
          message: "RESULT.txt did not contain the exact seeded result.",
        };
  },
};
