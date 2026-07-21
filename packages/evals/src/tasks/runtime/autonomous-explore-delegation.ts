// @summary Runtime eval for autonomous delegation of a multi-file known-key reference lookup

import type { RuntimeEvalExecution, RuntimeEvalTask } from "../../runtime-task";
import type { EvalDimension, EvalProfile } from "../../task";
import {
  createIsolatedFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  type RuntimeFixtureWorld,
  seededToken,
  writeFixture,
} from "./helpers";

const SOURCE_FILES = ["primary.txt", "routing.md", "marker.conf", "entry.txt", "reference.md", "routing.conf"];
const SOURCE_PATHS = SOURCE_FILES.map((file, index) => `reference-map/region-${index + 1}/${file}`);

export interface AutonomousExploreDelegationWorld extends RuntimeFixtureWorld {
  facts: string[];
  sourcePaths: string[];
  clientPrompt: string;
}

export const autonomousExploreDelegationTask: RuntimeEvalTask<AutonomousExploreDelegationWorld> = {
  id: "autonomous-explore-delegation",
  description: "Choose one read-only explore agent for a multi-file known-key lookup without being told to delegate.",
  fixtureVersion: "autonomous-explore-delegation-v2",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 10,
    maxToolCalls: 12,
    maxChildAgents: 1,
    maxChangedFiles: 0,
    maxChangedBytes: 0,
    timeoutMs: 240_000,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["spawn_agent", "wait", "read", "glob", "ls"],
    allowedCapabilities: ["collab", "read"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const facts = SOURCE_PATHS.map((_, index) => seededToken(seed, `REGION_${index + 1}`));
    await writeFixture(
      root,
      Object.fromEntries(SOURCE_PATHS.map((path, index) => [path, `region_marker=${facts[index]}\n`])),
    );
    return {
      root,
      seed,
      facts,
      sourcePaths: [...SOURCE_PATHS],
      clientPrompt:
        "Locate every definition of the known key region_marker across the regional subdirectories and filename " +
        "variants under reference-map/. Report the six values in region-number order with their defining file paths. " +
        "Keep the lookup read-only and do not interpret the values.",
      expected: facts.join("\n"),
      protectedPaths: [...SOURCE_PATHS],
      allowedChanges: [],
    };
  },
  createRuntimeConfig: createAgentEnabledConfig,
  createSteps: (world) => [{ kind: "turn", mode: "default", message: world.clientPrompt }],
  snapshotWorld: async (world) => ({ sourcePaths: world.sourcePaths }),
  evaluate(input) {
    const spawns = input.toolCalls.filter((call) => call.name === "spawn_agent" && call.outcome === "success");
    if (spawns.length !== 1 || !isExploreSpawn(spawns[0]!.input))
      return fail("spawn", "The multi-file reference lookup was not delegated to one explore agent.", "behavior");
    const reads = input.toolCalls.filter((call) => call.name === "read" && call.outcome === "success");
    const childIds = new Set(reads.map((call) => call.childThreadId).filter((id): id is string => Boolean(id)));
    if (childIds.size !== 1)
      return fail("actor", "The six reads were not isolated to one child actor.", "runtime_policy");
    const childId = [...childIds][0]!;
    for (const [index, path] of input.world.sourcePaths.entries()) {
      if (
        !reads.some(
          (call) =>
            call.childThreadId === childId &&
            toolPath(call.input).endsWith(path) &&
            toolOutput(call).includes(input.world.facts[index]!),
        )
      )
        return fail("coverage", `The explore agent did not ground ${path}.`, "semantic_goal");
    }
    if (reads.some((call) => call.threadId === input.session.threadId && call.childThreadId === undefined))
      return fail("parent_read", "The parent bypassed the delegated exploration with direct reads.", "behavior");
    if (!input.toolCalls.some((call) => call.name === "wait" && call.outcome === "success"))
      return fail("join", "The parent did not join the delegated exploration.", "behavior");
    const text = lastAssistantText(input);
    return input.world.facts.every((fact) => text.includes(fact))
      ? { passed: true }
      : fail("synthesis", "The final response omitted a grounded regional fact.", "semantic_goal");
  },
};

async function createAgentEnabledConfig(world: AutonomousExploreDelegationWorld, profile: EvalProfile) {
  const config = await createIsolatedFixtureRuntimeConfig(world, profile);
  config.diligent = { ...config.diligent, agents: { enabled: true } };
  return config;
}

function isExploreSpawn(value: unknown): boolean {
  return isRecord(value) && value.agent_type === "explore" && typeof value.message === "string";
}

function toolPath(value: unknown): string {
  return isRecord(value) && typeof value.file_path === "string" ? value.file_path : "";
}

function toolOutput(call: RuntimeEvalExecution<unknown>["toolCalls"][number]): string {
  if (typeof call.output === "string") return call.output;
  return isRecord(call.output) && typeof call.output.output === "string" ? call.output.output : "";
}

function lastAssistantText(input: Parameters<typeof autonomousExploreDelegationTask.evaluate>[0]): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string, message: string, dimension: EvalDimension) {
  return { passed: false as const, code: `autonomous_explore.${code}`, message, dimension };
}
