// @summary Runtime eval for two overlapping read-only children and ordered parent synthesis

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeEvalExecution, RuntimeEvalTask, RuntimeWorldSnapshot } from "../../runtime-task";
import type { EvalDimension, EvalProfile } from "../../task";
import {
  createIsolatedFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  matchesExactPatchInput,
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
  fixtureVersion: "collaboration-parallel-synthesis-v5",
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
    return recoveries > 0
      ? {
          passed: true,
          diagnostics: [
            {
              dimension: "efficiency",
              code: "collaboration_parallel_synthesis.bounded_recovery",
              message: `${recoveries} bounded recovery attempt${recoveries === 1 ? "" : "s"} preceded successful synthesis.`,
            },
          ],
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
    clientPrompt: `At the same time, assign exactly two separate read-only specialists to retrieve the exact contents of ${SOURCE_PATHS[0]} and ${SOURCE_PATHS[1]} exactly once each. Join both results once. Do not spawn any additional specialist; create the artifact yourself as the parent. Create a new file named ${ARTIFACT_PATH} containing the north token followed by a newline, the south token, and a trailing newline. Reply exactly ${FINAL_RESPONSE}.`,
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
  const writeRecovery = relativeEditRecoveryTrace(input);
  const readRecovery = relativeChildReadRecovery(input);
  const expectedTraceCount = 6 + Number(writeRecovery !== undefined) + Number(readRecovery !== undefined);
  if (
    input.toolCalls.length !== expectedTraceCount ||
    input.toolCalls.some(
      (call, index) =>
        call.sequence !== index + 1 ||
        (call !== writeRecovery &&
          call !== readRecovery?.failed &&
          (call.outcome !== "success" || call.error !== undefined)),
    )
  )
    return fail("trace_shape", "Expected six successful traces with at most one exact read and write recovery.");
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
    const child = input.childSessions.find((candidate) => candidate.threadId === childIds[index]);
    const childFinal = child ? sessionMessage(child.lines.at(-1)) : undefined;
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
      !exactReadInput(read.input, SOURCE_PATHS[index]) ||
      childFinal?.role !== "assistant" ||
      !exactAssistantContent(childFinal.content, input.world.tokens[index]!, true)
    )
      return fail("actor_contract", "Spawn or actor-attributed regional read evidence diverged.");
    const isolated = JSON.stringify([read, child]);
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
    write.name !== (input.profile.provider === "anthropic" ? "edit" : "apply_patch") ||
    write.capability !== "write" ||
    write.threadId !== rootId ||
    write.childThreadId !== undefined ||
    !exactWriteInput(write.input, input.profile.provider, input.world.expected)
  )
    return fail("write_contract", "The parent-only native write contract diverged.");
  if (writeRecovery && (wait.sequence >= writeRecovery.sequence || writeRecovery.sequence >= write.sequence))
    return fail(
      "write_recovery_order",
      "The bounded failed relative edit must occur between the join and exact write.",
    );
  if (input.toolCalls.some((call) => /send_input|resume|close_agent/.test(call.name)))
    return fail("extra_collaboration", "Unexpected collaboration behavior was recorded.");
}

function exactSpawnInput(input: unknown, world: CollaborationParallelSynthesisWorld, index: number): boolean {
  const message = isRecord(input) && typeof input.message === "string" ? input.message : undefined;
  if (
    !isRecord(input) ||
    !Object.keys(input).every((key) =>
      ["agent_type", "allow_nested_agents", "allowed_tools", "description", "message", "model_class"].includes(key),
    ) ||
    !message ||
    !message.includes(SOURCE_PATHS[index]) ||
    message.includes(SOURCE_PATHS[index === 0 ? 1 : 0]) ||
    (input.agent_type !== "explore" && input.agent_type !== "general") ||
    (input.allow_nested_agents !== undefined && input.allow_nested_agents !== false) ||
    (input.allowed_tools !== undefined && canonical(input.allowed_tools) !== canonical(["read"])) ||
    (input.model_class !== undefined && input.model_class !== "lite") ||
    (input.agent_type === "general" && input.model_class !== "lite") ||
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

function exactWriteInput(input: unknown, provider: string, expected: string) {
  if (provider === "anthropic")
    return (
      canonical(input) ===
      canonical({
        file_path: `$WORKSPACE/${ARTIFACT_PATH}`,
        old_string: "",
        new_string: expected,
        replace_all: false,
      })
    );
  const lines = expected.trimEnd().split("\n");
  return matchesExactPatchInput(
    input,
    `*** Begin Patch\n*** Add File: ${ARTIFACT_PATH}\n+${lines[0]}\n+${lines[1]}\n*** End Patch`,
  );
}

type CustomParallelTrace = RuntimeEvalExecution<CollaborationParallelSynthesisWorld>["toolCalls"][number];

function validateWorkspace(input: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>) {
  const initial = fixtureEntries(input.world);
  const rootId = input.session.threadId;
  const childIds = childIdsBySpawn(input);
  if (!childIds) return fail("workspace_ids", "Workspace child session ids were unavailable.");
  const expectedPaths = [
    ...initial.map((entry) => entry.path),
    ARTIFACT_PATH,
    ".diligent",
    ".diligent/.gitignore",
    ".diligent/images",
    ".diligent/knowledge",
    ".diligent/sessions",
    `.diligent/sessions/${rootId}.jsonl`,
    ...childIds.map((id) => `.diligent/sessions/${id}.jsonl`),
    ".diligent/skills",
  ].filter((path, index, all) => all.indexOf(path) === index);
  const artifact = input.workspace.final.entries.find((entry) => entry.path === ARTIFACT_PATH);
  const sourceEntries = input.workspace.final.entries.filter((entry) => SOURCE_PATHS.includes(entry.path as never));
  const expectedRuntimeFinal = input.workspace.final.entries
    .filter((entry) => entry.path === ".diligent" || entry.path.startsWith(".diligent/"))
    .map((entry) => ({ ...entry, category: runtimeCategory(entry.path) }));
  const expectedRuntimeDiff = expectedRuntimeFinal.map((entry) => ({
    path: entry.path,
    category: entry.category,
    change: "added",
  }));
  const verifier = input.verifier;
  if (
    canonical(input.workspace.initial.entries) !== canonical(initial) ||
    canonical(input.workspace.final.entries.map((entry) => entry.path).sort()) !== canonical(expectedPaths.sort()) ||
    canonical(artifact) !==
      canonical({
        path: ARTIFACT_PATH,
        kind: "file",
        size: Buffer.byteLength(input.world.expected),
        sha256: input.world.expectedHash,
        executable: false,
      }) ||
    canonical(sourceEntries) !== canonical(initial.filter((entry) => entry.kind === "file")) ||
    input.workspace.final.entries.filter((entry) => entry.path.startsWith(".diligent/sessions/")).length !== 3 ||
    !verifier ||
    canonical(verifier.argv) !== canonical(["eval-exact-files", ARTIFACT_PATH]) ||
    verifier.exitCode !== 0 ||
    verifier.timedOut ||
    verifier.stdout !== "Exact file verification passed.\n" ||
    verifier.stderr !== "" ||
    input.toolOutputFiles.length !== 0 ||
    input.compactions.length !== 0 ||
    input.protocolActions.length !== 0 ||
    input.userInputRequests.length !== 0 ||
    input.approvals.length !== 0 ||
    input.logs.length !== 0 ||
    input.runtimeState.initial.length !== 0 ||
    canonical(input.runtimeState.final) !== canonical(expectedRuntimeFinal) ||
    canonical(input.runtimeState.diff) !== canonical(expectedRuntimeDiff)
  )
    return fail("workspace", "Workspace manifests, protected hashes, verifier, or isolation evidence diverged.");
}

function runtimeCategory(path: string): "infrastructure" | "sessions" {
  return path.startsWith(".diligent/sessions/") ? "sessions" : "infrastructure";
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
  const writeName = input.profile.provider === "anthropic" ? "edit" : "apply_patch";
  const successfulWrites = input.toolCalls.filter(
    (trace) =>
      trace.name === writeName &&
      trace.outcome === "success" &&
      exactWriteInput(trace.input, input.profile.provider, input.world.expected),
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

interface RelativeChildReadRecovery {
  index: 0 | 1;
  failed: CustomParallelTrace;
  succeeded: CustomParallelTrace;
}

function relativeChildReadRecovery(
  input: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>,
): RelativeChildReadRecovery | undefined {
  const failedReads = input.toolCalls.filter((trace) => trace.name === "read" && trace.outcome !== "success");
  if (failedReads.length !== 1) return undefined;
  const failed = failedReads[0]!;
  const index = relativeRegionForRead(failed.input);
  const childIds = childIdsBySpawn(input);
  const succeeded =
    index === undefined ? undefined : traceById(input).get(index === 0 ? CALL_IDS.readNorth : CALL_IDS.readSouth);
  if (index === undefined || !childIds || !succeeded) return undefined;
  const path = SOURCE_PATHS[index];
  const error = `Error: file_path must be absolute: ${path}`;
  if (
    failed.sequence >= succeeded.sequence ||
    failed.outcome !== "runtime_error" ||
    failed.capability !== "read" ||
    failed.threadId !== childIds[index] ||
    failed.childThreadId !== childIds[index] ||
    failed.error !== error ||
    canonical(failed.input) !== canonical({ file_path: path }) ||
    canonical(failed.output) !==
      canonical({
        output: error,
        render: {
          outputSummary: error,
          blocks: [{ type: "text", title: "Output", text: error, isError: true }],
        },
        metadata: { error: true },
      }) ||
    input.toolCalls.some(
      (trace) =>
        trace.threadId === childIds[index] && trace.sequence > failed.sequence && trace.sequence < succeeded.sequence,
    )
  )
    return undefined;
  return { index, failed, succeeded };
}

function relativeEditRecoveryTrace(
  input: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>,
): CustomParallelTrace | undefined {
  if (input.profile.provider !== "anthropic") return undefined;
  const edits = input.toolCalls.filter((trace) => trace.name === "edit");
  if (edits.length !== 2) return undefined;
  const failed = edits.find((trace) => trace.outcome === "runtime_error");
  const succeeded = edits.find(
    (trace) =>
      trace.outcome === "success" && exactWriteInput(trace.input, input.profile.provider, input.world.expected),
  );
  const error = `Error: file_path must be absolute: ${ARTIFACT_PATH}`;
  if (
    !failed ||
    !succeeded ||
    failed.sequence >= succeeded.sequence ||
    failed.capability !== "write" ||
    failed.threadId !== input.session.threadId ||
    failed.childThreadId !== undefined ||
    failed.error !== error ||
    canonical(failed.input) !==
      canonical({
        file_path: ARTIFACT_PATH,
        old_string: "",
        new_string: input.world.expected,
        replace_all: false,
      }) ||
    canonical(failed.output) !== canonical({ output: error, metadata: { error: true } })
  )
    return undefined;
  return failed;
}

function regionForSpawn(input: unknown): 0 | 1 | undefined {
  const message = isRecord(input) && typeof input.message === "string" ? input.message : undefined;
  if (!message) return undefined;
  const matches = SOURCE_PATHS.map((path) => message.includes(path));
  return matches[0] === matches[1] ? undefined : matches[0] ? 0 : 1;
}

function relativeRegionForRead(input: unknown): 0 | 1 | undefined {
  if (!isRecord(input) || canonical(Object.keys(input)) !== canonical(["file_path"])) return undefined;
  const matches = SOURCE_PATHS.map((path) => input.file_path === path);
  return matches[0] === matches[1] ? undefined : matches[0] ? 0 : 1;
}

function childIdsBySpawn(
  input: RuntimeEvalExecution<CollaborationParallelSynthesisWorld>,
): [string, string] | undefined {
  const traces = traceById(input);
  const ids = [traces.get(CALL_IDS.readNorth)?.threadId, traces.get(CALL_IDS.readSouth)?.threadId];
  return ids[0] &&
    ids[1] &&
    ids[0] !== ids[1] &&
    ids.every((id) => input.childSessions.some((child) => child.threadId === id))
    ? [ids[0], ids[1]]
    : undefined;
}

function sessionMessage(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && value.type === "message" && isRecord(value.message) ? value.message : undefined;
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
