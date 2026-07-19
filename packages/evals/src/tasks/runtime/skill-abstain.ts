// @summary Runtime eval fixture proving abstention from attractive but irrelevant task-local skills

import type { RuntimeEvalExecution, RuntimeEvalTask } from "../../runtime-task";
import type { EvalDimension } from "../../task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  matchesExactPatchInput,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  verifyExactFiles,
  writeFixture,
} from "./helpers";

const OUTPUT_PATH = "STATUS.txt";
const SKILLS = [
  {
    name: "release-handoff",
    description: "Prepare a multi-section release handoff artifact from a release inventory.",
  },
  {
    name: "incident-brief",
    description: "Turn incident evidence into a triage brief with escalation guidance.",
  },
  {
    name: "dependency-review",
    description: "Analyze a dependency upgrade and produce a compatibility risk review.",
  },
] as const;

export interface SkillAbstainWorld extends RuntimeFixtureWorld {
  skillNames: string[];
  skillDescriptions: string[];
  skillPaths: string[];
  referencePaths: string[];
  requestedContent: string;
  expectedHash: string;
}

export const skillAbstainTask: RuntimeEvalTask<SkillAbstainWorld> = {
  id: "skill-abstain",
  description: "Complete a fully specified direct edit without loading irrelevant advertised skills.",
  fixtureVersion: "skill-abstain-v1",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 2, maxToolCalls: 2, timeoutMs: 240_000 },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["skill", "apply_patch", "edit"],
    allowedCapabilities: ["skill", "write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const requestedContent = `status=${seededToken(seed, "READY")}\n`;
    const files: Record<string, string> = {};
    for (const skill of SKILLS) {
      files[`.diligent/skills/${skill.name}/SKILL.md`] = [
        "---",
        `name: ${skill.name}`,
        `description: ${skill.description}`,
        "---",
        "Read `references/template.txt` before performing this specialized workflow.",
        "",
      ].join("\n");
      files[`.diligent/skills/${skill.name}/references/template.txt`] =
        `Irrelevant template ${seededToken(seed, skill.name)}\n`;
    }
    await writeFixture(root, files);
    const skillPaths = SKILLS.map((skill) => `.diligent/skills/${skill.name}/SKILL.md`);
    const referencePaths = SKILLS.map((skill) => `.diligent/skills/${skill.name}/references/template.txt`);
    return {
      root,
      seed,
      skillNames: SKILLS.map((skill) => skill.name),
      skillDescriptions: SKILLS.map((skill) => skill.description),
      skillPaths,
      referencePaths,
      requestedContent,
      expected: requestedContent,
      expectedHash: sha256Text(requestedContent),
      protectedPaths: [...skillPaths, ...referencePaths],
      allowedChanges: [OUTPUT_PATH],
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: (world) => [
    {
      kind: "turn",
      message: `Create STATUS.txt with exactly this content, including the final newline:\n${world.requestedContent}`,
    },
  ],
  verify: (world, signal) => verifyExactFiles(world, { [OUTPUT_PATH]: world.expected }, signal),
  snapshotWorld: async (world) => ({ result: await exactFile(world.root, OUTPUT_PATH) }),
  evaluate(input) {
    if (input.toolCalls.some((call) => call.name === "skill"))
      return failure("skill_called", "An irrelevant skill was loaded.", "behavior");
    if (input.toolCalls.some((call) => call.capability === "read"))
      return failure("skill_file_read", "A skill or reference file was read directly.", "runtime_policy");
    const writes = input.toolCalls.filter((call) => call.capability === "write");
    if (writes.length !== 1 || writes[0]?.outcome !== "success" || !isExactCreate(writes[0], input.world.expected)) {
      const dimension = writes.some(writeTargetsOutput) ? "format_contract" : "runtime_policy";
      return failure("wrong_write", "The task did not perform the one exact ordinary workspace write.", dimension);
    }
    if (input.verifier?.timedOut)
      return failure("verifier_timeout", "Independent exact-file verification timed out.", "harness_terminal");
    if (input.verifier?.exitCode !== 0)
      return failure("verifier", "Independent exact-file verification did not pass.", "format_contract");
    const result = input.workspace.final.entries.find((entry) => entry.path === OUTPUT_PATH);
    return result?.sha256 === input.world.expectedHash
      ? { passed: true }
      : failure("wrong_result", `${OUTPUT_PATH} did not contain the exact requested content.`, "format_contract");
  },
};

function isExactCreate(call: RuntimeEvalExecution<unknown>["toolCalls"][number], content: string): boolean {
  if (call.input === null || typeof call.input !== "object" || Array.isArray(call.input)) return false;
  const input = call.input as Record<string, unknown>;
  if (call.name === "apply_patch") return matchesExactPatchInput(input, exactAddPatch(OUTPUT_PATH, content));
  return (
    call.name === "edit" &&
    Object.keys(input).length === 4 &&
    input.file_path === `$WORKSPACE/${OUTPUT_PATH}` &&
    input.old_string === "" &&
    input.new_string === content &&
    input.replace_all === false
  );
}

function writeTargetsOutput(call: RuntimeEvalExecution<unknown>["toolCalls"][number]): boolean {
  if (call.input === null || typeof call.input !== "object" || Array.isArray(call.input)) return false;
  const input = call.input as Record<string, unknown>;
  if (call.name === "edit") return input.file_path === `$WORKSPACE/${OUTPUT_PATH}`;
  return (
    call.name === "apply_patch" && typeof input.patch === "string" && input.patch.includes(` File: ${OUTPUT_PATH}`)
  );
}

function exactAddPatch(path: string, content: string): string {
  return `*** Begin Patch\n*** Add File: ${path}\n${content
    .split("\n")
    .slice(0, -1)
    .map((line) => `+${line}`)
    .join("\n")}\n*** End Patch`;
}

function failure(suffix: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `skill_abstain.${suffix}`, message, dimension };
}
