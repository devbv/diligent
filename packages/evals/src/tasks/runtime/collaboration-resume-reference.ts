// @summary Runtime eval for resuming one persisted read-only child across an app-server restart

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

const SOURCE_PATHS = ["references/initial.fact", "references/follow-up.fact"] as const;
const ARTIFACT_PATH = "collaboration-resume-reference.txt";
const ACK = "REFERENCE_ACK";
const FINAL = "REFERENCE_PAIR_RECORDED";
const AGENT_TYPE = "explore";
const CALL_IDS = {
  spawnInitial: "resume-reference-spawn-1",
  readInitial: "resume-reference-read-2",
  waitInitial: "resume-reference-wait-3",
  spawnFollowUp: "resume-reference-spawn-4",
  readFollowUp: "resume-reference-read-5",
  waitFollowUp: "resume-reference-wait-6",
  write: "resume-reference-write-7",
} as const;

interface RuntimeConfigRecord {
  agentsEnabled: boolean;
  builtinNames: string[];
}

export interface CollaborationResumeReferenceWorld extends RuntimeFixtureWorld {
  tokens: [string, string];
  sourcePaths: [string, string];
  sourceHashes: [string, string];
  artifactPath: string;
  prompts: [string, string];
  workerBriefs: [string, string];
  acknowledgement: string;
  finalResponse: string;
  expectedHash: string;
  runtimeConfigs: RuntimeConfigRecord[];
}

export const collaborationResumeReferenceTask: RuntimeEvalTask<CollaborationResumeReferenceWorld> = {
  id: "collaboration-resume-reference",
  description: "Resume the same persisted read-only specialist after restart and record two ordered facts.",
  fixtureVersion: "collaboration-resume-reference-v4",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 12,
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
  createRuntimeConfig: createResumeRuntimeConfig,
  createSteps: (world) => [
    { kind: "turn", mode: "default", message: world.prompts[0] },
    { kind: "restart_and_resume" },
    { kind: "turn", mode: "default", message: world.prompts[1] },
  ],
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
    if (input.turns.length !== 2) return fail("turns", "Expected the original and resumed parent turns.");
    const failure = validateTools(input) ?? validateWorkspace(input) ?? validateFinal(input);
    if (failure) return failure;
    return input.toolCalls.some((call) => call.outcome === "runtime_error")
      ? {
          passed: true,
          diagnostics: [
            {
              dimension: "efficiency",
              code: "collaboration_resume_reference.bounded_recovery",
              message: "One bounded provider-native recovery preceded successful resumed synthesis.",
            },
          ],
        }
      : { passed: true };
  },
};

async function createResumeRuntimeConfig(world: CollaborationResumeReferenceWorld, profile: EvalProfile) {
  const config = await createIsolatedFixtureRuntimeConfig(world, profile);
  config.diligent = { ...config.diligent, agents: { enabled: true } };
  world.runtimeConfigs.push({
    agentsEnabled: config.diligent.agents?.enabled === true,
    builtinNames: config.agentDefinitions.map((definition) => definition.name),
  });
  return config;
}

function fixtureFor(seed: string) {
  const tokens: [string, string] = [seededToken(seed, "FIRST_REFERENCE"), seededToken(seed, "SECOND_REFERENCE")];
  const expected = `${tokens[0]}\n${tokens[1]}\n`;
  return {
    tokens,
    sourcePaths: [...SOURCE_PATHS] as [string, string],
    sourceHashes: [sha256Text(`${tokens[0]}\n`), sha256Text(`${tokens[1]}\n`)] as [string, string],
    artifactPath: ARTIFACT_PATH,
    prompts: [
      `Use exactly one lite read-only specialist to read ${SOURCE_PATHS[0]} exactly once and retain the value for later. Wait once for completion, keep the value private in your reply, and reply with exactly ${ACK}.`,
      `Resume that same persisted specialist to read only ${SOURCE_PATHS[1]} exactly once without rereading the initial file. Wait once, then create ${ARTIFACT_PATH} containing the two returned values in initial-then-follow-up order, one per line with a final newline. Reply with exactly ${FINAL}.`,
    ] as [string, string],
    workerBriefs: [
      `Read only ${SOURCE_PATHS[0]} exactly once. Retain its exact token for the resumed assignment and report completion. Do not inspect any other reference.`,
      `Continue the prior assignment by reading only ${SOURCE_PATHS[1]} exactly once. Return the retained initial token followed by the follow-up token. Do not reread the initial reference.`,
    ] as [string, string],
    acknowledgement: ACK,
    finalResponse: FINAL,
    expected,
    expectedHash: sha256Text(expected),
  };
}

function validateTools(input: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const recovery = anthropicAbsentFileRecoveryTrace(input);
  const expectedCount = recovery ? 8 : 7;
  if (
    input.toolCalls.length !== expectedCount ||
    input.toolCalls.some(
      (call, index) =>
        call.sequence !== index + 1 ||
        typeof call.toolCallId !== "string" ||
        call.toolCallId.length === 0 ||
        (call !== recovery && (call.outcome !== "success" || call.error !== undefined)),
    ) ||
    new Set(input.toolCalls.map((call) => call.toolCallId)).size !== input.toolCalls.length
  )
    return fail("tool_shape", "Expected seven successful calls with at most one exact absent-file edit recovery.");
  const traces = traceMap(input);
  const childId = spawnedChildId(input);
  const firstSpawn = traces.get(CALL_IDS.spawnInitial);
  const secondSpawn = traces.get(CALL_IDS.spawnFollowUp);
  if (!childId || !firstSpawn || !secondSpawn) return fail("spawn_missing", "Spawn evidence was incomplete.");
  if (
    !exactSpawnInput(firstSpawn.input, input.world, false) ||
    !exactSpawnInput(secondSpawn.input, input.world, true, childId) ||
    firstSpawn.threadId !== input.session.threadId ||
    secondSpawn.threadId !== input.session.threadId ||
    firstSpawn.childThreadId !== undefined ||
    secondSpawn.childThreadId !== undefined
  )
    return fail("spawn_contract", "The original id and nickname were not reused by the exact resume spawn.");
  for (let index = 0; index < 2; index += 1) {
    const read = traces.get(index === 0 ? CALL_IDS.readInitial : CALL_IDS.readFollowUp);
    if (
      !read ||
      read.name !== "read" ||
      read.capability !== "read" ||
      read.threadId !== childId ||
      read.childThreadId !== childId ||
      !exactReadInput(read.input, SOURCE_PATHS[index])
    )
      return fail("child_read", "Each child turn must perform its one exact protected read under the reused id.");
  }
  const waits = [traces.get(CALL_IDS.waitInitial), traces.get(CALL_IDS.waitFollowUp)];
  if (
    waits.some(
      (wait) =>
        !wait ||
        wait.name !== "wait" ||
        wait.capability !== "collab" ||
        wait.threadId !== input.session.threadId ||
        wait.childThreadId !== undefined ||
        !exactWaitInput(wait.input, childId),
    )
  )
    return fail("wait_contract", "Each parent turn must wait once on the same canonical child id.");
  const childReports = input.childSessions[0]!.lines.flatMap((line) => {
    const value = sessionMessage(line);
    const message = isRecord(value) ? value : undefined;
    return message?.role === "assistant" ? [message.content] : [];
  });
  if (
    input.world.tokens.some((token) => !childReports.some((content) => exactAssistantContent(content, token, true, [])))
  )
    return fail("wait_contract", "The resumed child reports did not contain both assigned source facts.");
  const write = traces.get(CALL_IDS.write);
  if (
    !write ||
    write.name !== (input.profile.provider === "anthropic" ? "edit" : "apply_patch") ||
    write.capability !== "write" ||
    write.threadId !== input.session.threadId ||
    write.childThreadId !== undefined ||
    !exactWriteInput(write.input, input.profile.provider, input.world.expected)
  )
    return fail("write_contract", "The parent-only exact native write diverged.");
  const followUpWait = traces.get(CALL_IDS.waitFollowUp);
  if (recovery && (!followUpWait || followUpWait.sequence >= recovery.sequence || recovery.sequence >= write.sequence))
    return fail(
      "write_recovery_order",
      "The exact failed edit must occur between the follow-up wait and exact create.",
    );
  if (input.toolCalls.some((call) => call.childThreadId && call.capability !== "read"))
    return fail("nested_child", "The child performed a non-read or nested collaboration action.");
}

function validateWorkspace(input: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const initial = fixtureEntries(input.world);
  const childId = spawnedChildId(input);
  if (!childId) return fail("workspace_id", "Workspace child id was unavailable.");
  const expectedPaths = [
    ...initial.map((entry) => entry.path),
    ARTIFACT_PATH,
    ".diligent",
    ".diligent/.gitignore",
    ".diligent/images",
    ".diligent/knowledge",
    ".diligent/sessions",
    `.diligent/sessions/${input.session.threadId}.jsonl`,
    `.diligent/sessions/${childId}.jsonl`,
    ".diligent/skills",
  ];
  const artifact = input.workspace.final.entries.find((entry) => entry.path === ARTIFACT_PATH);
  const sources = input.workspace.final.entries.filter((entry) => SOURCE_PATHS.includes(entry.path as never));
  const runtimeFinal = input.workspace.final.entries
    .filter((entry) => entry.path === ".diligent" || entry.path.startsWith(".diligent/"))
    .map((entry) => ({ ...entry, category: runtimeCategory(entry.path) }));
  const runtimeDiff = runtimeFinal.map((entry) => ({ path: entry.path, category: entry.category, change: "added" }));
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
    canonical(sources) !== canonical(initial.filter((entry) => entry.kind === "file")) ||
    input.workspace.final.entries.filter((entry) => entry.path.startsWith(".diligent/sessions/")).length !== 2 ||
    input.runtimeState.initial.length !== 0 ||
    canonical(input.runtimeState.final) !== canonical(runtimeFinal) ||
    canonical(input.runtimeState.diff) !== canonical(runtimeDiff) ||
    !input.verifier ||
    canonical(input.verifier.argv) !== canonical(["eval-exact-files", ARTIFACT_PATH]) ||
    input.verifier.exitCode !== 0 ||
    input.verifier.timedOut ||
    input.verifier.stdout !== "Exact file verification passed.\n" ||
    input.verifier.stderr !== "" ||
    input.toolOutputFiles.length !== 0
  )
    return fail("workspace", "Workspace, runtime-state, or verifier evidence diverged.");
}

function validateFinal(input: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  if (
    !exactAssistant(input.turns[0]!.messages.at(-1), input.world.acknowledgement) ||
    !exactAssistant(input.turns[1]!.messages.at(-1), input.world.finalResponse) ||
    input.approvals.length !== 0 ||
    input.userInputRequests.length !== 0 ||
    input.logs.length !== 0 ||
    input.toolOutputFiles.length !== 0
  )
    return fail("final", "Terse finals or forbidden side-channel evidence diverged.");
}

function exactSpawnInput(input: unknown, world: CollaborationResumeReferenceWorld, resume: boolean, childId?: string) {
  if (!isRecord(input) || typeof input.message !== "string") return false;
  const message = input.message;
  const allowedKeys = new Set([
    "message",
    "description",
    "agent_type",
    "resume_id",
    "allow_nested_agents",
    "model_class",
    "allowed_tools",
  ]);
  const allowedTools = input.allowed_tools;
  const exactAllowedTools =
    allowedTools === undefined ||
    (Array.isArray(allowedTools) &&
      (allowedTools.length === 0 || (allowedTools.length === 1 && allowedTools[0] === "read")));
  return (
    Object.keys(input).every((key) => allowedKeys.has(key)) &&
    message.includes(SOURCE_PATHS[resume ? 1 : 0]) &&
    !world.tokens.some((token) => message.includes(token)) &&
    (resume ? input.agent_type === undefined || input.agent_type === AGENT_TYPE : input.agent_type === AGENT_TYPE) &&
    (resume ? input.resume_id === childId : input.resume_id === undefined) &&
    (input.description === undefined ||
      (typeof input.description === "string" && input.description.length > 0 && input.description.length <= 160)) &&
    (input.allow_nested_agents === undefined || input.allow_nested_agents === false) &&
    (input.model_class === undefined || input.model_class === "lite") &&
    exactAllowedTools
  );
}

function exactReadInput(input: unknown, path: string) {
  if (!isRecord(input)) return false;
  const keys = Object.keys(input);
  return (
    keys.every((key) => key === "file_path" || key === "limit" || key === "offset") &&
    (input.file_path === path || input.file_path === `$WORKSPACE/${path}`) &&
    (input.limit === undefined || input.limit === 2_000) &&
    (input.offset === undefined || input.offset === 1)
  );
}

function exactWaitInput(input: unknown, childId: string) {
  if (!isRecord(input) || canonical(input.ids) !== canonical([childId])) return false;
  if (Object.keys(input).some((key) => key !== "ids" && key !== "timeout_ms")) return false;
  return (
    input.timeout_ms === undefined ||
    (typeof input.timeout_ms === "number" &&
      Number.isInteger(input.timeout_ms) &&
      input.timeout_ms > 0 &&
      input.timeout_ms <= 3_600_000)
  );
}

function exactWriteInput(input: unknown, provider: string, expected: string) {
  if (provider === "anthropic")
    return (
      isRecord(input) &&
      Object.keys(input).every((key) => ["file_path", "old_string", "new_string", "replace_all"].includes(key)) &&
      input.file_path === `$WORKSPACE/${ARTIFACT_PATH}` &&
      input.old_string === "" &&
      input.new_string === expected &&
      (input.replace_all === undefined || input.replace_all === false)
    );
  const [first, second] = expected.trimEnd().split("\n");
  return matchesExactPatchInput(
    input,
    `*** Begin Patch\n*** Add File: ${ARTIFACT_PATH}\n+${first}\n+${second}\n*** End Patch`,
  );
}

function fixtureEntries(world: CollaborationResumeReferenceWorld): RuntimeWorldSnapshot["entries"] {
  return [
    { path: "references", kind: "directory" as const, size: 0 },
    ...SOURCE_PATHS.map((path, index) => ({
      path,
      kind: "file" as const,
      size: Buffer.byteLength(`${world.tokens[index]}\n`),
      sha256: world.sourceHashes[index],
      executable: false,
    })),
  ].sort((a, b) => a.path.localeCompare(b.path));
}

function runtimeCategory(path: string): "infrastructure" | "sessions" {
  return path.startsWith(".diligent/sessions/") ? "sessions" : "infrastructure";
}

function traceMap(input: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  const traces = new Map(input.toolCalls.map((trace) => [trace.toolCallId, trace]));
  const unique = (matches: typeof input.toolCalls) => (matches.length === 1 ? matches[0] : undefined);
  const spawns = input.toolCalls.filter((trace) => trace.name === "spawn_agent" && isRecord(trace.input));
  const reads = input.toolCalls.filter((trace) => trace.name === "read");
  const waits = input.toolCalls.filter((trace) => trace.name === "wait").sort((a, b) => a.sequence - b.sequence);
  const writeName = input.profile.provider === "anthropic" ? "edit" : "apply_patch";
  const aliases = [
    [CALL_IDS.spawnInitial, unique(spawns.filter((trace) => spawnResumeId(trace.input) === undefined))],
    [CALL_IDS.spawnFollowUp, unique(spawns.filter((trace) => typeof spawnResumeId(trace.input) === "string"))],
    [CALL_IDS.readInitial, unique(reads.filter((trace) => exactReadInput(trace.input, SOURCE_PATHS[0])))],
    [CALL_IDS.readFollowUp, unique(reads.filter((trace) => exactReadInput(trace.input, SOURCE_PATHS[1])))],
    [CALL_IDS.waitInitial, waits.length === 2 ? waits[0] : undefined],
    [CALL_IDS.waitFollowUp, waits.length === 2 ? waits[1] : undefined],
    [
      CALL_IDS.write,
      unique(
        input.toolCalls.filter(
          (trace) =>
            trace.name === writeName &&
            trace.outcome === "success" &&
            exactWriteInput(trace.input, input.profile.provider, input.world.expected),
        ),
      ),
    ],
  ] as const;
  for (const [alias, trace] of aliases) if (trace) traces.set(alias, trace);
  return traces;
}

function anthropicAbsentFileRecoveryTrace(input: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  if (input.profile.provider !== "anthropic") return undefined;
  const edits = input.toolCalls.filter((trace) => trace.name === "edit");
  if (edits.length !== 2) return undefined;
  const failed = edits.find((trace) => trace.outcome === "runtime_error");
  const succeeded = edits.find(
    (trace) =>
      trace.outcome === "success" && exactWriteInput(trace.input, input.profile.provider, input.world.expected),
  );
  const error = `Error reading file: ENOENT: no such file or directory, open '$WORKSPACE/${ARTIFACT_PATH}'`;
  if (
    !failed ||
    !succeeded ||
    failed.sequence + 1 !== succeeded.sequence ||
    failed.capability !== "write" ||
    failed.threadId !== input.session.threadId ||
    failed.childThreadId !== undefined ||
    failed.error !== error ||
    !isRecord(failed.input) ||
    !Object.keys(failed.input).every((key) => ["file_path", "old_string", "new_string", "replace_all"].includes(key)) ||
    failed.input.file_path !== `$WORKSPACE/${ARTIFACT_PATH}` ||
    failed.input.old_string !== "DOES_NOT_EXIST_PLACEHOLDER" ||
    failed.input.new_string !== input.world.expected ||
    (failed.input.replace_all !== undefined && failed.input.replace_all !== false) ||
    canonical(failed.output) !== canonical({ output: error, metadata: { error: true } })
  )
    return undefined;
  return failed;
}

function spawnResumeId(input: unknown) {
  return isRecord(input) ? input.resume_id : undefined;
}

function spawnedChildId(input: RuntimeEvalExecution<CollaborationResumeReferenceWorld>) {
  return input.childSessions.length === 1 ? input.childSessions[0]!.threadId : undefined;
}

function sessionMessage(value: unknown) {
  return isRecord(value) && value.type === "message" ? value.message : undefined;
}

function exactAssistant(value: unknown, text: string, allowTrailingReport = false, forbiddenTokens: string[] = []) {
  const message = isRecord(value) && value.type === "message" ? value.message : value;
  return (
    isRecord(message) &&
    message.role === "assistant" &&
    exactAssistantContent(message.content, text, allowTrailingReport, forbiddenTokens)
  );
}

function exactAssistantContent(
  value: unknown,
  expected: string,
  allowTrailingReport: boolean,
  forbiddenTokens: string[],
) {
  if (!Array.isArray(value)) return false;
  const textBlocks = value.filter((block) => isRecord(block) && block.type === "text");
  return (
    textBlocks.length === 1 &&
    value.every((block) => isRecord(block) && (block.type === "thinking" || block.type === "text")) &&
    (allowTrailingReport
      ? reportMatchesToken(textBlocks[0]!.text, expected, forbiddenTokens)
      : textBlocks[0]!.text === expected)
  );
}

function reportMatchesToken(value: unknown, token: string, forbiddenTokens: string[] = []): boolean {
  if (value === token || value === `${token}\n`) return true;
  if (typeof value !== "string" || value.length > 1_000 || value.includes("\0")) return false;
  return value.includes(token) && forbiddenTokens.every((forbidden) => !value.includes(forbidden));
}

function canonical(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
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

const RESUME_FAILURE_DIMENSIONS = {
  turns: "behavior",
  tool_shape: "behavior",
  spawn_missing: "behavior",
  spawn_contract: "runtime_policy",
  child_read: "runtime_policy",
  wait_contract: "behavior",
  write_contract: "runtime_policy",
  write_recovery_order: "runtime_policy",
  nested_child: "runtime_policy",
  workspace_id: "runtime_policy",
  workspace: "runtime_policy",
  final: "semantic_goal",
} as const satisfies Record<string, EvalDimension>;

function fail(code: keyof typeof RESUME_FAILURE_DIMENSIONS, message: string) {
  return {
    passed: false as const,
    code: `collaboration_resume_reference.${code}`,
    message,
    dimension: RESUME_FAILURE_DIMENSIONS[code],
  };
}

export const COLLABORATION_RESUME_REFERENCE_TOOL_CALL_IDS = CALL_IDS;
