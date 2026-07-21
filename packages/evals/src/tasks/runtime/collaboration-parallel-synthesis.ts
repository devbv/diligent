// @summary Runtime eval for two overlapping read-only children and ordered parent synthesis

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeEvalExecution, RuntimeEvalTask, RuntimeWorldSnapshot } from "../../runtime-task";
import type { EvalDimension, EvalProfile } from "../../task";
import {
  createIsolatedFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  verifyExactFiles,
  writeFixture,
} from "./helpers";

const SOURCE_PATHS = ["regions/north/coordination.fact", "regions/south/coordination.fact"] as const;
const ARTIFACT_PATH = "parallel-synthesis.txt";
const FINAL_RESPONSE = "PARALLEL_SYNTHESIS_RECORDED";
const CALL_IDS = {
  spawnNorth: "parallel-spawn-north-1",
  spawnSouth: "parallel-spawn-south-2",
  readNorth: "parallel-read-north-3",
  readSouth: "parallel-read-south-4",
  wait: "parallel-wait-5",
  write: "parallel-write-6",
} as const;

interface RuntimeConfigRecord {
  agentsEnabled: boolean;
  builtinNames: string[];
}

export interface CollaborationParallelSynthesisWorld extends RuntimeFixtureWorld {
  tokens: [string, string];
  sourcePaths: [string, string];
  sourceHashes: [string, string];
  artifactPath: string;
  clientPrompt: string;
  workerBriefs: [string, string];
  finalResponse: string;
  expectedHash: string;
  runtimeConfigs: RuntimeConfigRecord[];
}

export const collaborationParallelSynthesisTask: RuntimeEvalTask<CollaborationParallelSynthesisWorld> = {
  id: "collaboration-parallel-synthesis",
  description: "Run two independent read-only specialists concurrently and synthesize their facts in fixed order.",
  fixtureVersion: "collaboration-parallel-synthesis-v8",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 10,
    maxToolCalls: 8,
    maxChangedFiles: 1,
    maxChangedBytes: 128,
    maxChildAgents: 2,
    timeoutMs: 180_000,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["spawn_agent", "wait", "read", "apply_patch", "edit"],
    allowedCapabilities: ["collab", "read", "write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const fixture = fixtureFor(seed);
    await writeFixture(root, {
      [SOURCE_PATHS[0]]: `${fixture.tokens[0]}\n`,
      [SOURCE_PATHS[1]]: `${fixture.tokens[1]}\n`,
    });
    return {
      root,
      seed,
      protectedPaths: [...SOURCE_PATHS],
      allowedChanges: [ARTIFACT_PATH],
      ...fixture,
      runtimeConfigs: [],
    };
  },
  createRuntimeConfig: createParallelRuntimeConfig,
  createSteps: (world) => [{ kind: "turn", mode: "default", message: world.clientPrompt }],
  verify: (world, signal) => verifyExactFiles(world, { [ARTIFACT_PATH]: world.expected }, signal),
  snapshotWorld: async (world) => ({
    artifact: await exactFile(world.root, ARTIFACT_PATH),
    artifactHash: sha256Text((await exactFile(world.root, ARTIFACT_PATH)) ?? ""),
    sourceHashes: await Promise.all(
      SOURCE_PATHS.map(async (path) => sha256Text(await readFile(join(world.root, path), "utf8"))),
    ),
    runtimeConfigs: world.runtimeConfigs,
  }),
  evaluate(input) {
    const failure = validateTraces(input) ?? validateWorkspace(input) ?? validateFinal(input);
    if (failure) return failure;
    const recoveries = input.toolCalls.filter((call) => call.outcome === "runtime_error").length;
    const extraSafeReads = Math.max(
      0,
      input.toolCalls.filter((call) => call.name === "read" && call.outcome === "success").length - 2,
    );
    const diagnostics = [
      ...(recoveries > 0
        ? [
            {
              dimension: "efficiency" as const,
              code: "collaboration_parallel_synthesis.bounded_recovery",
              message: `${recoveries} bounded recovery attempt${recoveries === 1 ? "" : "s"} preceded successful synthesis.`,
            },
          ]
        : []),
      ...(extraSafeReads > 0
        ? [
            {
              dimension: "efficiency" as const,
              code: "collaboration_parallel_synthesis.additional_safe_read",
              message: `${extraSafeReads} additional bounded in-scope read${extraSafeReads === 1 ? "" : "s"} preceded successful synthesis.`,
            },
          ]
        : []),
    ];
    return diagnostics.length > 0
      ? {
          passed: true,
          diagnostics,
        }
      : { passed: true };
  },
};

async function createParallelRuntimeConfig(world: CollaborationParallelSynthesisWorld, profile: EvalProfile) {
  const config = await createIsolatedFixtureRuntimeConfig(world, profile);
  config.diligent = { ...config.diligent, agents: { enabled: true } };
  world.runtimeConfigs.push({
    agentsEnabled: config.diligent.agents?.enabled === true,
    builtinNames: config.agentDefinitions.map((definition) => definition.name),
  });
  return config;
}

function fixtureFor(seed: string) {
  const tokens: [string, string] = [seededToken(seed, "NORTH_FACT"), seededToken(seed, "SOUTH_FACT")];
  const expected = `${tokens[0]}\n${tokens[1]}\n`;
  return {
    tokens,
    sourcePaths: [...SOURCE_PATHS] as [string, string],
    sourceHashes: [sha256Text(`${tokens[0]}\n`), sha256Text(`${tokens[1]}\n`)] as [string, string],
    artifactPath: ARTIFACT_PATH,
    clientPrompt:
      `Retrieve the independent coordination facts from ${SOURCE_PATHS[0]} and ${SOURCE_PATHS[1]}. ` +
      "Treat them as latency-sensitive independent investigations: use the same read-only exploration role for both, " +
      "complete them concurrently, and keep each regional investigation isolated from the other. " +
      "The main task must not directly read either source; it should only synthesize the two returned results. " +
      `Create ${ARTIFACT_PATH} containing the north fact followed by a newline, the south fact, and a trailing newline. ` +
      `Do not modify either source. Reply exactly ${FINAL_RESPONSE}.`,
    workerBriefs: [
      `Read only ${SOURCE_PATHS[0]} exactly once. Return only its exact token, without commentary or a trailing newline. Do not inspect any other region.`,
      `Read only ${SOURCE_PATHS[1]} exactly once. Return only its exact token, without commentary or a trailing newline. Do not inspect any other region.`,
    ] as [string, string],
    finalResponse: FINAL_RESPONSE,
    expected,
    expectedHash: sha256Text(expected),
  };
}

function validateTraces(input: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>) {
  const recoveries = input.toolCalls.filter((call) => call.outcome === "runtime_error");
  if (
    input.toolCalls.length < 6 ||
    input.toolCalls.length > 8 ||
    recoveries.length > 2 ||
    input.toolCalls.some(
      (call, index) =>
        call.sequence !== index + 1 ||
        call.outcome === "policy_rejection" ||
        (call.outcome === "runtime_error" && !isSafeRecovery(call)),
    )
  )
    return fail("trace_shape", "Expected bounded successful collaboration with only in-scope read/write recovery.");
  const traces = traceById(input);
  const callIds = input.toolCalls.map((call) => call.toolCallId);
  if (
    Object.values(CALL_IDS).some((id) => !traces.has(id)) ||
    callIds.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(callIds).size !== callIds.length
  )
    return fail("trace_ids", "Tool trace ids were not semantically resolved and unique.");
  const childIds = childIdsBySpawn(input);
  if (!childIds) return fail("trace_children", "Spawn traces did not establish two distinct children.");
  const rootId = input.session.threadId;
  for (let index = 0; index < 2; index += 1) {
    const spawn = traces.get(index === 0 ? CALL_IDS.spawnNorth : CALL_IDS.spawnSouth);
    const read = traces.get(index === 0 ? CALL_IDS.readNorth : CALL_IDS.readSouth);
    if (
      !spawn ||
      spawn.name !== "spawn_agent" ||
      spawn.capability !== "collab" ||
      spawn.threadId !== rootId ||
      spawn.childThreadId !== undefined ||
      !exactSpawnInput(spawn.input, input.world, index) ||
      !read ||
      read.name !== "read" ||
      read.capability !== "read" ||
      read.threadId !== childIds[index] ||
      read.childThreadId !== childIds[index] ||
      !exactReadInput(read.input, SOURCE_PATHS[index])
    )
      return fail("actor_contract", "Spawn or actor-attributed regional read evidence diverged.");
    const isolated = JSON.stringify(read);
    const other = index === 0 ? 1 : 0;
    if (isolated.includes(SOURCE_PATHS[other]) || isolated.includes(input.world.tokens[other]!))
      return fail("cross_region", "A child read or persisted evidence from the other region.");
  }
  const spawnNorth = traces.get(CALL_IDS.spawnNorth)!;
  const spawnSouth = traces.get(CALL_IDS.spawnSouth)!;
  const wait = traces.get(CALL_IDS.wait)!;
  const write = traces.get(CALL_IDS.write)!;
  if (spawnNorth.sequence >= wait.sequence || spawnSouth.sequence >= wait.sequence)
    return fail("parent_order", "Both specialists must be spawned before the parent joins them.");
  if (
    wait.name !== "wait" ||
    wait.capability !== "collab" ||
    wait.threadId !== rootId ||
    wait.childThreadId !== undefined
  )
    return fail("wait_trace", "The join trace was not attributed to the parent collaboration capability.");
  if (!exactWaitInput(wait.input, childIds))
    return fail("wait_input", "The parent join did not target exactly the two spawned specialists.");
  if (
    !["edit", "apply_patch"].includes(write.name) ||
    write.capability !== "write" ||
    write.threadId !== rootId ||
    write.childThreadId !== undefined ||
    !targetsArtifact(write.input)
  )
    return fail("write_contract", "The parent-only artifact write contract diverged.");
  if (input.toolCalls.some((call) => /send_input|resume|close_agent/.test(call.name)))
    return fail("extra_collaboration", "Unexpected collaboration behavior was recorded.");
}

function exactSpawnInput(input: unknown, world: CollaborationParallelSynthesisWorld, index: number): boolean {
  const message = isRecord(input) && typeof input.message === "string" ? input.message : undefined;
  if (
    !isRecord(input) ||
    !Object.keys(input).every((key) => ["agent_type", "allow_nested_agents", "description", "message"].includes(key)) ||
    !message ||
    !message.includes(SOURCE_PATHS[index]) ||
    message.includes(SOURCE_PATHS[index === 0 ? 1 : 0]) ||
    input.agent_type !== "explore" ||
    (input.allow_nested_agents !== undefined && input.allow_nested_agents !== false) ||
    (input.description !== undefined &&
      (typeof input.description !== "string" ||
        input.description.length < 8 ||
        input.description.length > 160 ||
        !input.description.toLowerCase().includes(index === 0 ? "north" : "south")))
  )
    return false;
  const lower = message.toLowerCase();
  return (
    message.length >= 20 &&
    message.length <= 1_000 &&
    lower.includes(index === 0 ? "north" : "south") &&
    [world.tokens[0], world.tokens[1]].every((token) => !message.includes(token))
  );
}

function exactWaitInput(input: unknown, childIds: [string, string]): boolean {
  if (
    !isRecord(input) ||
    !Object.keys(input).every((key) => ["ids", "timeout_ms"].includes(key)) ||
    !sameStringMembers(input.ids, childIds)
  )
    return false;
  return (
    input.timeout_ms === undefined ||
    (typeof input.timeout_ms === "number" &&
      Number.isInteger(input.timeout_ms) &&
      input.timeout_ms >= 1 &&
      input.timeout_ms <= 900_000)
  );
}

function exactReadInput(input: unknown, path: string): boolean {
  return (
    isRecord(input) &&
    Object.keys(input).every((key) => ["file_path", "limit", "offset"].includes(key)) &&
    input.file_path === `$WORKSPACE/${path}` &&
    (input.offset === undefined || input.offset === 1) &&
    (input.limit === undefined ||
      (typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit >= 2))
  );
}

function targetsArtifact(input: unknown): boolean {
  if (!isRecord(input)) return false;
  if (typeof input.file_path === "string")
    return input.file_path === ARTIFACT_PATH || input.file_path === `$WORKSPACE/${ARTIFACT_PATH}`;
  if (typeof input.patch !== "string") return false;
  const targets = [...input.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]);
  return targets.length === 1 && targets[0] === ARTIFACT_PATH;
}

function isSafeRecovery(trace: CustomParallelTrace): boolean {
  if (trace.capability === "write") return targetsArtifact(trace.input);
  if (trace.capability !== "read" || !isRecord(trace.input) || typeof trace.input.file_path !== "string") return false;
  const filePath = trace.input.file_path;
  return SOURCE_PATHS.some((path) => filePath === path || filePath === `$WORKSPACE/${path}`);
}

type CustomParallelTrace = RuntimeEvalExecution<CollaborationParallelSynthesisWorld>["toolCalls"][number];

function validateWorkspace(input: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>) {
  const initial = fixtureEntries(input.world);
  const artifact = input.workspace.final.entries.find((entry) => entry.path === ARTIFACT_PATH);
  const sourceEntries = input.workspace.final.entries.filter((entry) => SOURCE_PATHS.includes(entry.path as never));
  const verifier = input.verifier;
  const unexpectedProject = input.workspace.final.entries.some(
    (entry) =>
      entry.path !== ARTIFACT_PATH &&
      !entry.path.startsWith(".diligent") &&
      !initial.some((expected) => expected.path === entry.path),
  );
  if (
    canonical(input.workspace.initial.entries) !== canonical(initial) ||
    canonical(artifact) !==
      canonical({
        path: ARTIFACT_PATH,
        kind: "file",
        size: Buffer.byteLength(input.world.expected),
        sha256: input.world.expectedHash,
        executable: false,
      }) ||
    canonical(sourceEntries) !== canonical(initial.filter((entry) => entry.kind === "file")) ||
    unexpectedProject ||
    !verifier ||
    verifier.exitCode !== 0 ||
    verifier.timedOut ||
    input.compactions.length !== 0 ||
    input.protocolActions.length !== 0 ||
    input.userInputRequests.length !== 0 ||
    input.approvals.length !== 0 ||
    input.runtimeState.diff.some((change) => change.category !== "infrastructure" && change.category !== "sessions")
  )
    return fail("workspace", "Project artifacts, protected sources, verifier result, or isolation policy diverged.");
}

function fixtureEntries(world: CollaborationParallelSynthesisWorld): RuntimeWorldSnapshot["entries"] {
  return [
    { path: "regions", kind: "directory", size: 0 },
    { path: "regions/north", kind: "directory", size: 0 },
    {
      path: SOURCE_PATHS[0],
      kind: "file",
      size: Buffer.byteLength(`${world.tokens[0]}\n`),
      sha256: world.sourceHashes[0],
      executable: false,
    },
    { path: "regions/south", kind: "directory", size: 0 },
    {
      path: SOURCE_PATHS[1],
      kind: "file",
      size: Buffer.byteLength(`${world.tokens[1]}\n`),
      sha256: world.sourceHashes[1],
      executable: false,
    },
  ].sort((left, right) => left.path.localeCompare(right.path)) as RuntimeWorldSnapshot["entries"];
}

function validateFinal(input: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>) {
  const final = input.turns[0]!.messages.at(-1);
  if (
    !final ||
    final.role !== "assistant" ||
    !exactAssistantContent(final.content, FINAL_RESPONSE, false) ||
    input.world.tokens.some((token) => JSON.stringify(final).includes(token))
  )
    return fail("final", "Expected the exact terse final response without fact leakage.");
}

function traceById(input: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>) {
  const traces = new Map(input.toolCalls.map((trace) => [trace.toolCallId, trace]));
  const unique = (name: string) => {
    const matches = input.toolCalls.filter((trace) => trace.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const spawns = input.toolCalls.filter((trace) => trace.name === "spawn_agent");
  const reads = input.toolCalls.filter((trace) => trace.name === "read" && trace.outcome === "success");
  const spawnNorth = spawns.find((trace) => regionForSpawn(trace.input) === 0);
  const spawnSouth = spawns.find((trace) => regionForSpawn(trace.input) === 1);
  const readNorth = reads.find((trace) => exactReadInput(trace.input, SOURCE_PATHS[0]));
  const readSouth = reads.find((trace) => exactReadInput(trace.input, SOURCE_PATHS[1]));
  const wait = unique("wait");
  const successfulWrites = input.toolCalls.filter(
    (trace) =>
      (trace.name === "edit" || trace.name === "apply_patch") &&
      trace.outcome === "success" &&
      targetsArtifact(trace.input),
  );
  const write = successfulWrites.length === 1 ? successfulWrites[0] : undefined;
  for (const [alias, trace] of [
    [CALL_IDS.spawnNorth, spawnNorth],
    [CALL_IDS.spawnSouth, spawnSouth],
    [CALL_IDS.readNorth, readNorth],
    [CALL_IDS.readSouth, readSouth],
    [CALL_IDS.wait, wait],
    [CALL_IDS.write, write],
  ] as const) {
    if (trace) traces.set(alias, trace);
  }
  return traces;
}

function regionForSpawn(input: unknown): 0 | 1 | undefined {
  const message = isRecord(input) && typeof input.message === "string" ? input.message : undefined;
  if (!message) return undefined;
  const matches = SOURCE_PATHS.map((path) => message.includes(path));
  return matches[0] === matches[1] ? undefined : matches[0] ? 0 : 1;
}

function childIdsBySpawn(
  input: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>,
): [string, string] | undefined {
  const traces = traceById(input);
  const ids = [traces.get(CALL_IDS.readNorth)?.threadId, traces.get(CALL_IDS.readSouth)?.threadId];
  return ids[0] && ids[1] && ids[0] !== ids[1] ? [ids[0], ids[1]] : undefined;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sameStringMembers(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string") &&
    canonical([...value].sort()) === canonical([...expected].sort())
  );
}

function reportMatchesToken(value: unknown, token: string): boolean {
  if (value === token || value === `${token}\n`) return true;
  if (typeof value !== "string") return false;
  const fenced = /^```\n([\s\S]*?)\n```$/.exec(value);
  if (fenced !== null && (fenced[1] === token || fenced[1] === `${token}\n`)) return true;
  return value.length <= 1_000 && !value.includes("\0") && value.includes(token);
}

function exactAssistantContent(value: unknown, expected: string, allowTrailingNewline: boolean): boolean {
  if (!Array.isArray(value)) return false;
  const textBlocks = value.filter((block) => isRecord(block) && block.type === "text");
  return (
    textBlocks.length === 1 &&
    value.every((block) => isRecord(block) && (block.type === "thinking" || block.type === "text")) &&
    (allowTrailingNewline ? reportMatchesToken(textBlocks[0]!.text, expected) : textBlocks[0]!.text === expected)
  );
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObjectKeys(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

const PARALLEL_FAILURE_DIMENSIONS = {
  trace_shape: "behavior",
  trace_ids: "runtime_policy",
  trace_children: "runtime_policy",
  actor_contract: "runtime_policy",
  cross_region: "runtime_policy",
  parent_order: "behavior",
  wait_trace: "behavior",
  wait_input: "behavior",
  write_contract: "runtime_policy",
  write_recovery_order: "runtime_policy",
  extra_collaboration: "runtime_policy",
  workspace_ids: "runtime_policy",
  workspace: "runtime_policy",
  final: "semantic_goal",
} as const satisfies Record<string, EvalDimension>;

function fail(code: keyof typeof PARALLEL_FAILURE_DIMENSIONS, message: string) {
  return {
    passed: false as const,
    code: `collaboration_parallel_synthesis.${code}`,
    message,
    dimension: PARALLEL_FAILURE_DIMENSIONS[code],
  };
}

export const COLLABORATION_PARALLEL_SYNTHESIS_TOOL_CALL_IDS = CALL_IDS;
