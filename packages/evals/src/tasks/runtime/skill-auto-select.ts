// @summary Runtime eval fixture for intent-based skill selection and one declared reference read

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

const OUTPUT_PATH = "HANDOFF.txt";
const SELECTED_SKILL = "release-handoff";
const SELECTED_REFERENCE = ".diligent/skills/release-handoff/references/rendering-rule.txt";

const SKILLS = [
  {
    name: SELECTED_SKILL,
    description: "Prepare a release handoff artifact using the project's prescribed handoff workflow.",
    reference: "references/rendering-rule.txt",
  },
  {
    name: "incident-brief",
    description: "Summarize an operational incident using the project's triage and escalation workflow.",
    reference: "references/triage-rule.txt",
  },
  {
    name: "dependency-review",
    description: "Review dependency upgrade risk using the project's compatibility audit workflow.",
    reference: "references/audit-rule.txt",
  },
] as const;

export interface SkillAutoSelectWorld extends RuntimeFixtureWorld {
  skillNames: string[];
  skillDescriptions: string[];
  selectedSkillName: string;
  selectedReferencePath: string;
  decoyReferencePaths: string[];
  ruleToken: string;
  expectedHash: string;
}

export const skillAutoSelectTask: RuntimeEvalTask<SkillAutoSelectWorld> = {
  id: "skill-auto-select",
  description: "Select one uniquely matching task-local skill and read only its declared reference.",
  fixtureVersion: "skill-auto-select-v2",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 5, maxToolCalls: 4, timeoutMs: 240_000 },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["skill", "read", "apply_patch", "edit"],
    allowedCapabilities: ["skill", "read", "write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const ruleToken = seededToken(seed, "HANDOFF_RULE");
    const expected = `Release capsule: ${ruleToken}\n`;
    const files: Record<string, string> = {};
    for (const skill of SKILLS) {
      const selected = skill.name === SELECTED_SKILL;
      files[`.diligent/skills/${skill.name}/SKILL.md`] = [
        "---",
        `name: ${skill.name}`,
        `description: ${skill.description}`,
        "---",
        `Read exactly \`${skill.reference}\` and follow its rule. Do not read any other file.`,
        "",
      ].join("\n");
      files[`.diligent/skills/${skill.name}/${skill.reference}`] = selected
        ? `Create ${OUTPUT_PATH} with exactly this content, including the final newline:\n${expected}`
        : `This decoy rule must never be loaded (${seededToken(seed, skill.name)}).\n`;
    }
    await writeFixture(root, files);
    const skillPaths = SKILLS.map((skill) => `.diligent/skills/${skill.name}/SKILL.md`);
    const referencePaths = SKILLS.map((skill) => `.diligent/skills/${skill.name}/${skill.reference}`);
    return {
      root,
      seed,
      skillNames: SKILLS.map((skill) => skill.name),
      skillDescriptions: SKILLS.map((skill) => skill.description),
      selectedSkillName: SELECTED_SKILL,
      selectedReferencePath: SELECTED_REFERENCE,
      decoyReferencePaths: referencePaths.filter((path) => path !== SELECTED_REFERENCE),
      ruleToken,
      expected,
      expectedHash: sha256Text(expected),
      protectedPaths: [...skillPaths, ...referencePaths],
      allowedChanges: [OUTPUT_PATH],
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: () => [
    {
      kind: "turn",
      message:
        "Prepare a release handoff artifact by following the project's specialized handoff workflow. Save the finished artifact as HANDOFF.txt.",
    },
  ],
  verify: (world, signal) => verifyExactFiles(world, { [OUTPUT_PATH]: world.expected }, signal),
  snapshotWorld: async (world) => ({ result: await exactFile(world.root, OUTPUT_PATH) }),
  evaluate(input) {
    const [first] = input.toolCalls;
    if (first?.name !== "skill" || !exactObject(first.input, { name: input.world.selectedSkillName }))
      return failure("skill_not_first", "The expected skill was not the first procedural tool call.", "behavior");
    const skillCalls = input.toolCalls.filter((call) => call.name === "skill");
    if (skillCalls.length !== 1)
      return failure("unexpected_skill_call", "Exactly one skill call was required.", "runtime_policy");
    const reads = input.toolCalls.filter((call) => call.name === "read");
    const expectedRead = { file_path: `$WORKSPACE/${input.world.selectedReferencePath}` };
    if (reads.length !== 1 || reads[0]?.outcome !== "success" || !exactObject(reads[0]?.input, expectedRead))
      return failure(
        "wrong_reference_reads",
        "The selected declared reference was not the only file read.",
        "runtime_policy",
      );
    const writes = input.toolCalls.filter((call) => call.capability === "write");
    const directCreate =
      writes.length === 1 && writes[0]?.outcome === "success" && isExactCreate(writes[0], input.world.expected);
    if (!directCreate && !isAnthropicAbsentFileRecovery(input, writes)) {
      const dimension = writes.some(writeTargetsOutput) ? "format_contract" : "runtime_policy";
      return failure("wrong_write", "The task did not perform an accepted exact output write.", dimension);
    }
    if (input.verifier?.timedOut)
      return failure("verifier_timeout", "Independent exact-file verification timed out.", "harness_terminal");
    if (input.verifier?.exitCode !== 0)
      return failure("verifier", "Independent exact-file verification did not pass.", "format_contract");
    const result = input.workspace.final.entries.find((entry) => entry.path === OUTPUT_PATH);
    return result?.sha256 === input.world.expectedHash
      ? { passed: true }
      : failure("wrong_result", `${OUTPUT_PATH} did not contain the exact opaque-rule result.`, "format_contract");
  },
};

function exactObject(actual: unknown, expected: Record<string, string>): boolean {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  const entries = Object.entries(actual as Record<string, unknown>);
  return entries.length === Object.keys(expected).length && entries.every(([key, value]) => expected[key] === value);
}

function isExactCreate(call: RuntimeEvalExecution<unknown>["toolCalls"][number], content: string): boolean {
  if (call.name === "apply_patch") return matchesExactPatchInput(call.input, exactAddPatch(OUTPUT_PATH, content));
  if (call.name !== "edit" || call.input === null || typeof call.input !== "object" || Array.isArray(call.input))
    return false;
  const input = call.input as Record<string, unknown>;
  return (
    Object.keys(input).length === 4 &&
    input.file_path === `$WORKSPACE/${OUTPUT_PATH}` &&
    input.old_string === "" &&
    input.new_string === content &&
    input.replace_all === false
  );
}

function writeTargetsOutput(call: RuntimeEvalExecution<unknown>["toolCalls"][number]): boolean {
  if (!isRecord(call.input)) return false;
  if (call.name === "edit") return call.input.file_path === `$WORKSPACE/${OUTPUT_PATH}`;
  return (
    call.name === "apply_patch" &&
    typeof call.input.patch === "string" &&
    call.input.patch.includes(` File: ${OUTPUT_PATH}`)
  );
}

function isAnthropicAbsentFileRecovery(
  input: RuntimeEvalExecution<SkillAutoSelectWorld>,
  writes: RuntimeEvalExecution<unknown>["toolCalls"],
): boolean {
  if (input.profile.provider !== "anthropic" || writes.length !== 2) return false;
  const [failed, succeeded] = [...writes].sort((left, right) => left.sequence - right.sequence);
  const error = `Error reading file: ENOENT: no such file or directory, open '$WORKSPACE/${OUTPUT_PATH}'`;
  if (
    !failed ||
    !succeeded ||
    failed.sequence + 1 !== succeeded.sequence ||
    failed.name !== "edit" ||
    failed.outcome !== "runtime_error" ||
    failed.threadId !== input.session.threadId ||
    failed.childThreadId !== undefined ||
    failed.error !== error ||
    !isRecord(failed.input) ||
    Object.keys(failed.input).length !== 4 ||
    failed.input.file_path !== `$WORKSPACE/${OUTPUT_PATH}` ||
    failed.input.old_string !== "placeholder" ||
    failed.input.new_string !== "placeholder" ||
    failed.input.replace_all !== false ||
    !isExactMissingFileOutput(failed.output, error) ||
    succeeded.sequence !== failed.sequence + 1 ||
    succeeded.threadId !== input.session.threadId ||
    succeeded.childThreadId !== undefined ||
    succeeded.outcome !== "success" ||
    !isExactCreate(succeeded, input.world.expected)
  )
    return false;
  return true;
}

function isExactMissingFileOutput(output: unknown, error: string): boolean {
  if (!isRecord(output) || Object.keys(output).length !== 2 || output.output !== error || !isRecord(output.metadata))
    return false;
  return Object.keys(output.metadata).length === 1 && output.metadata.error === true;
}

function exactAddPatch(path: string, content: string): string {
  return `*** Begin Patch\n*** Add File: ${path}\n${content
    .split("\n")
    .slice(0, -1)
    .map((line) => `+${line}`)
    .join("\n")}\n*** End Patch`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failure(suffix: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `skill_auto_select.${suffix}`, message, dimension };
}
