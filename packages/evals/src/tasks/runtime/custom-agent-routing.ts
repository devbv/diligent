// @summary Runtime eval for routing one protected fact through a discovered custom agent

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  discoverAgents,
  getBuiltinAgentDefinitions,
  renderAgentsSection,
  resolveAvailableAgentDefinitions,
} from "@diligent/runtime";
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

const RELEASE_AGENT = "release-authorization-liaison";
const DECOY_AGENT = "incident-operations-liaison";
const RELEASE_DESCRIPTION = "Retrieves the current release authorization capsule for a bounded delivery decision";
const DECOY_DESCRIPTION = "Investigates active service incidents and prepares operational response context";
const RELEASE_PATH = "vault/current-release.capsule";
const DECOY_PATH = "vault/incident-override.capsule";
const ARTIFACT_PATH = "release-authorization.txt";
const FINAL_RESPONSE = "RELEASE_AUTHORIZATION_RECORDED";
const SPAWN_CALL_ID = "route-spawn-call-1";
const READ_CALL_ID = "route-read-call-2";
const WAIT_CALL_ID = "route-wait-call-3";
const WRITE_CALL_ID = "route-write-call-4";
const RELEASE_BODY =
  `You are the release authorization liaison. The release capsule path relative to the workspace is ${RELEASE_PATH}. ` +
  `Call read exactly once with an absolute file_path: copy the Current working directory from the runtime context exactly, then append the fixed suffix /${RELEASE_PATH} without altering either string. ` +
  "Return only the source's exact contents, and do not inspect unrelated operational material.";
const DECOY_BODY =
  "You are the incident operations liaison. Investigate explicitly requested live-service incident material and return concise operational context without performing release authorization work.";

interface AgentFixtureRecord {
  name: string;
  description: string;
  body: string;
  tools?: string[];
  defaultModelClass?: string;
  path: string;
  content: string;
  hash: string;
}

interface RuntimeConfigRecord {
  discoveredNames: string[];
  availableNames: string[];
  catalogCustomNames: string[];
  definitionCustomNames: string[];
  agentsEnabled: boolean;
  systemAgentsSection: string;
}

export interface CustomAgentRoutingWorld extends RuntimeFixtureWorld {
  releaseToken: string;
  decoyToken: string;
  releaseAgent: AgentFixtureRecord;
  decoyAgent: AgentFixtureRecord;
  releasePath: string;
  decoyPath: string;
  artifactPath: string;
  clientPrompt: string;
  workerBrief: string;
  finalResponse: string;
  expectedHash: string;
  releaseSourceHash: string;
  decoySourceHash: string;
  runtimeConfigs: RuntimeConfigRecord[];
}

export const customAgentRoutingTask: RuntimeEvalTask<CustomAgentRoutingWorld> = {
  id: "custom-agent-routing",
  description: "Select one discovered custom role to retrieve a protected release fact and persist it exactly.",
  fixtureVersion: "custom-agent-routing-v9",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 7,
    maxToolCalls: 5,
    maxChangedFiles: 1,
    maxChangedBytes: 64,
    maxChildAgents: 1,
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
      [fixture.releaseAgent.path]: fixture.releaseAgent.content,
      [fixture.decoyAgent.path]: fixture.decoyAgent.content,
      [RELEASE_PATH]: `${fixture.releaseToken}\n`,
      [DECOY_PATH]: `${fixture.decoyToken}\n`,
    });
    return {
      root,
      seed,
      protectedPaths: [fixture.releaseAgent.path, fixture.decoyAgent.path, RELEASE_PATH, DECOY_PATH],
      allowedChanges: [ARTIFACT_PATH],
      ...fixture,
      runtimeConfigs: [],
    };
  },
  createRuntimeConfig: createCustomAgentRuntimeConfig,
  createSteps: (world) => [{ kind: "turn", mode: "default", message: world.clientPrompt }],
  verify: (world, signal) => verifyExactFiles(world, { [ARTIFACT_PATH]: world.expected }, signal),
  snapshotWorld: async (world) => ({
    artifact: await exactFile(world.root, ARTIFACT_PATH),
    artifactHash: sha256Text((await exactFile(world.root, ARTIFACT_PATH)) ?? ""),
    releaseAgentHash: sha256Text(await readFile(join(world.root, world.releaseAgent.path), "utf8")),
    decoyAgentHash: sha256Text(await readFile(join(world.root, world.decoyAgent.path), "utf8")),
    releaseSourceHash: sha256Text(await readFile(join(world.root, RELEASE_PATH), "utf8")),
    decoySourceHash: sha256Text(await readFile(join(world.root, DECOY_PATH), "utf8")),
    runtimeConfigs: world.runtimeConfigs,
  }),
  evaluate(input) {
    const failure = validateTraces(input) ?? validateWorkspaceAndIsolation(input) ?? validateFinal(input);
    if (failure) return failure;
    return input.toolCalls.some((call) => call.outcome === "runtime_error")
      ? {
          passed: true,
          diagnostics: [
            {
              dimension: "efficiency",
              code: "custom_agent_routing.bounded_recovery",
              message: "One bounded provider-native recovery preceded successful routing.",
            },
          ],
        }
      : { passed: true };
  },
};

async function createCustomAgentRuntimeConfig(world: CustomAgentRoutingWorld, profile: EvalProfile) {
  const config = await createIsolatedFixtureRuntimeConfig(world, profile);
  const discovery = await discoverAgents({
    cwd: world.root,
    globalConfigDir: join(world.root, ".eval-global"),
    knownToolNames: ["read"],
  });
  if (discovery.errors.length > 0) throw new Error(`custom_agent_fixture.discovery: ${discovery.errors[0]!.error}`);
  const definitions = resolveAvailableAgentDefinitions(getBuiltinAgentDefinitions(), discovery.agents);
  const agentsSection = renderAgentsSection(discovery.agents);
  config.diligent = { ...config.diligent, agents: { enabled: true } };
  config.discoveredAgents = discovery.agents;
  config.agents = discovery.agents;
  config.agentCatalog = [
    ...getBuiltinAgentDefinitions().map((definition) => ({
      definition,
      source: "builtin" as const,
      required: definition.name === "general",
    })),
    ...definitions
      .filter((definition) => definition.source === "user")
      .map((definition, index) => ({ definition, source: discovery.agents[index]!.source, required: false })),
  ];
  config.agentDefinitions = definitions;
  config.systemPrompt = [...config.systemPrompt, { label: "agents", content: agentsSection }];
  world.runtimeConfigs.push({
    discoveredNames: discovery.agents.map((agent) => agent.name),
    availableNames: config.agents.map((agent) => agent.name),
    catalogCustomNames: config.agentCatalog
      .filter((entry) => entry.definition.source === "user")
      .map((entry) => entry.definition.name),
    definitionCustomNames: definitions
      .filter((definition) => definition.source === "user")
      .map((definition) => definition.name),
    agentsEnabled: config.diligent.agents?.enabled === true,
    systemAgentsSection: agentsSection,
  });
  return config;
}

function fixtureFor(seed: string) {
  const releaseToken = seededToken(seed, "RELEASE_CAPSULE");
  const decoyToken = seededToken(seed, "INCIDENT_OVERRIDE");
  const releaseAgent = agentFixture(RELEASE_AGENT, RELEASE_DESCRIPTION, RELEASE_BODY, ["read"], "lite");
  const decoyAgent = agentFixture(DECOY_AGENT, DECOY_DESCRIPTION, DECOY_BODY);
  const expected = `${releaseToken}\n`;
  return {
    releaseToken,
    decoyToken,
    releaseAgent,
    decoyAgent,
    releasePath: RELEASE_PATH,
    decoyPath: DECOY_PATH,
    artifactPath: ARTIFACT_PATH,
    clientPrompt: `Please retrieve the current release authorization capsule through the most appropriate available specialist, create a new file named ${ARTIFACT_PATH} containing exactly the capsule contents including its trailing newline, and then reply exactly ${FINAL_RESPONSE}.`,
    workerBrief: `Read only ${RELEASE_PATH} exactly once. Return only the capsule token, without commentary or a trailing newline.`,
    finalResponse: FINAL_RESPONSE,
    expected,
    expectedHash: sha256Text(expected),
    releaseSourceHash: sha256Text(expected),
    decoySourceHash: sha256Text(`${decoyToken}\n`),
  };
}

function agentFixture(
  name: string,
  description: string,
  body: string,
  tools?: string[],
  defaultModelClass?: string,
): AgentFixtureRecord {
  const path = `.diligent/agents/${name}/AGENT.md`;
  const optionalTools = tools ? `tools:\n${tools.map((tool) => `  - ${tool}`).join("\n")}\n` : "";
  const optionalModel = defaultModelClass ? `model_class: ${defaultModelClass}\n` : "";
  const content = `---\nname: ${name}\ndescription: ${description}\n${optionalTools}${optionalModel}---\n\n${body}\n`;
  return { name, description, body, tools, defaultModelClass, path, content, hash: sha256Text(content) };
}

type CustomRoutingTrace = RuntimeEvalExecution<CustomAgentRoutingWorld>["toolCalls"][number];

interface CustomRoutingTraces {
  spawn: CustomRoutingTrace;
  read: CustomRoutingTrace;
  wait: CustomRoutingTrace;
  writeRecovery?: CustomRoutingTrace;
  write: CustomRoutingTrace;
}

function routingTraces(input: RuntimeEvalExecution<CustomAgentRoutingWorld>): CustomRoutingTraces | undefined {
  const unique = (name: string) => {
    const matches = input.toolCalls.filter((call) => call.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const spawn = unique("spawn_agent");
  const read = unique("read");
  const wait = unique("wait");
  const writeName = input.profile.provider === "anthropic" ? "edit" : "apply_patch";
  const writeAttempts = input.toolCalls.filter((call) => call.name === writeName);
  const write = writeAttempts.at(-1);
  const writeRecovery = writeAttempts.length === 2 ? writeAttempts[0] : undefined;
  const expectedCount = writeRecovery ? 5 : 4;
  return spawn &&
    read &&
    wait &&
    write &&
    writeAttempts.length >= 1 &&
    writeAttempts.length <= 2 &&
    input.toolCalls.length === expectedCount
    ? { spawn, read, wait, writeRecovery, write }
    : undefined;
}

function validateTraces(input: RuntimeEvalExecution<CustomAgentRoutingWorld>) {
  const traces = routingTraces(input);
  if (!traces) return fail("trace_order", "Expected one spawn, child read, wait, and native write trace.");
  const { spawn, read, wait, writeRecovery, write } = traces;
  const childReport = childReportText(input);
  const callIds = input.toolCalls.map((call) => call.toolCallId);
  if (
    input.toolCalls.some(
      (call, index) =>
        call.sequence !== index + 1 ||
        (call !== writeRecovery && (call.outcome !== "success" || call.error !== undefined)),
    ) ||
    callIds.some((callId) => typeof callId !== "string" || callId.length === 0) ||
    new Set(callIds).size !== callIds.length ||
    spawn.sequence !== 1 ||
    write.sequence !== input.toolCalls.length ||
    (writeRecovery !== undefined && writeRecovery.sequence !== input.toolCalls.length - 1) ||
    canonical([read.sequence, wait.sequence].sort()) !== canonical([2, 3])
  )
    return fail("trace_order", "Expected the bounded successful spawn/read/wait/write schedule and linked IDs.");
  const rootId = input.session.threadId;
  const childId = input.childSessions[0]?.threadId;
  if (
    spawn.threadId !== rootId ||
    spawn.childThreadId !== undefined ||
    spawn.capability !== "collab" ||
    !exactSpawnInput(spawn.input, input.world) ||
    !childId ||
    read.threadId !== childId ||
    read.childThreadId !== childId ||
    read.capability !== "read" ||
    !exactReadInput(read.input) ||
    wait.threadId !== rootId ||
    wait.childThreadId !== undefined ||
    wait.capability !== "collab" ||
    !exactWaitInput(wait.input, childId) ||
    !childReport ||
    !exactChildReport(childReport, input.world) ||
    write.threadId !== rootId ||
    write.childThreadId !== undefined ||
    write.capability !== "write" ||
    (writeRecovery !== undefined && !exactWriteRecovery(writeRecovery, input)) ||
    !exactWriteInput(write.input, input.profile.provider, input.world.releaseToken)
  )
    return fail("trace_contract", "Trace actors, selected inputs, or child report behavior diverged.");
  const childEvidence = JSON.stringify([read, input.childSessions[0]]);
  if ([DECOY_AGENT, DECOY_PATH, input.world.decoyToken].some((value) => childEvidence.includes(value)))
    return fail("decoy_access", "The child trace or session accessed decoy material.");
}

function exactSpawnInput(input: unknown, world: CustomAgentRoutingWorld): boolean {
  if (
    !isRecord(input) ||
    !Object.keys(input).every((key) => ["agent_type", "description", "message"].includes(key)) ||
    !Object.hasOwn(input, "agent_type") ||
    !Object.hasOwn(input, "message") ||
    input.agent_type !== RELEASE_AGENT ||
    (input.description !== undefined && typeof input.description !== "string") ||
    typeof input.message !== "string"
  )
    return false;
  const description = typeof input.description === "string" ? input.description.toLowerCase() : "";
  const message = input.message.toLowerCase();
  const descriptionTerms = ["release", "authorization", "capsule"].filter((term) => description.includes(term));
  const groundedDescription = input.description === undefined || descriptionTerms.length >= 2;
  const groundedMessage =
    message.includes("release") &&
    message.includes("capsule") &&
    (message.includes("authorization") || message.includes(RELEASE_PATH.toLowerCase()));
  const forbidden = [DECOY_AGENT, DECOY_PATH, world.decoyToken, "incident"].map((value) => value.toLowerCase());
  return (
    (input.description === undefined || (input.description.length >= 8 && input.description.length <= 160)) &&
    input.message.length >= 20 &&
    input.message.length <= 1_000 &&
    groundedDescription &&
    groundedMessage &&
    forbidden.every((value) => !description.includes(value) && !message.includes(value))
  );
}

function exactWaitInput(input: unknown, childId: string): boolean {
  if (
    !isRecord(input) ||
    !Object.keys(input).every((key) => ["ids", "timeout_ms"].includes(key)) ||
    !Object.hasOwn(input, "ids") ||
    canonical(input.ids) !== canonical([childId])
  )
    return false;
  return (
    input.timeout_ms === undefined ||
    (typeof input.timeout_ms === "number" &&
      Number.isInteger(input.timeout_ms) &&
      input.timeout_ms >= 1 &&
      input.timeout_ms <= 3_600_000)
  );
}

function exactReadInput(input: unknown): boolean {
  return (
    isRecord(input) && canonical(Object.keys(input)) === canonical(["file_path"]) && exactReadPath(input.file_path)
  );
}

function exactReadPath(path: unknown): boolean {
  return path === `$WORKSPACE/${RELEASE_PATH}`;
}

function exactWriteRecovery(trace: CustomRoutingTrace, input: RuntimeEvalExecution<CustomAgentRoutingWorld>): boolean {
  if (
    trace.capability !== "write" ||
    trace.threadId !== input.session.threadId ||
    trace.childThreadId !== undefined ||
    trace.outcome !== "runtime_error"
  )
    return false;
  if (input.profile.provider === "anthropic") {
    const error = `Error: file_path must be absolute: ${ARTIFACT_PATH}`;
    return (
      trace.name === "edit" &&
      trace.error === error &&
      canonical(trace.input) ===
        canonical({
          file_path: ARTIFACT_PATH,
          old_string: "",
          new_string: input.world.expected,
          replace_all: false,
        }) &&
      canonical(trace.output) === canonical({ output: error, metadata: { error: true } })
    );
  }
  const patch =
    `*** Begin Patch\n*** Add File: ${ARTIFACT_PATH}\n+${input.world.releaseToken}\n` +
    "*** End of File\n*** End Patch";
  const error = "apply_patch verification failed: Unknown patch header: *** End of File";
  return (
    trace.name === "apply_patch" &&
    trace.error === error &&
    canonical(trace.input) === canonical({ patch }) &&
    canonical(trace.output) ===
      canonical({
        output: error,
        render: {
          inputSummary: "*** Begin Patch",
          outputSummary: error,
          blocks: [
            { type: "text", title: "Input", text: patch },
            { type: "text", title: "Output", text: error, isError: true },
          ],
        },
        metadata: { error: true },
      })
  );
}

function exactWriteInput(input: unknown, provider: string, token: string): boolean {
  if (!isRecord(input)) return false;
  if (provider === "anthropic")
    return (
      canonical(input) ===
      canonical({
        file_path: `$WORKSPACE/${ARTIFACT_PATH}`,
        old_string: "",
        new_string: `${token}\n`,
        replace_all: false,
      })
    );
  return matchesExactPatchInput(input, `*** Begin Patch\n*** Add File: ${ARTIFACT_PATH}\n+${token}\n*** End Patch`);
}

function sessionMessage(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && value.type === "message" && isRecord(value.message) ? value.message : undefined;
}

function validateWorkspaceAndIsolation(input: RuntimeEvalExecution<CustomAgentRoutingWorld>) {
  const initial = fixtureEntries(input.world);
  const projectPaths = new Set([...initial.map((entry) => entry.path), ARTIFACT_PATH]);
  const finalProject = input.workspace.final.entries.filter((entry) => projectPaths.has(entry.path));
  const unexpectedProject = input.workspace.final.entries.some(
    (entry) => !entry.path.startsWith(".diligent/") && !projectPaths.has(entry.path),
  );
  const expectedFinal = [...initial, artifactEntry(input.world)].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const rootId = input.session.threadId;
  const childId = input.childSessions[0]!.threadId;
  const expectedFinalPaths = [
    ...expectedFinal.map((entry) => entry.path),
    ".diligent/.gitignore",
    ".diligent/images",
    ".diligent/knowledge",
    ".diligent/sessions",
    `.diligent/sessions/${rootId}.jsonl`,
    `.diligent/sessions/${childId}.jsonl`,
    ".diligent/skills",
  ].sort((left, right) => left.localeCompare(right));
  const finalSessionEntries = input.workspace.final.entries.filter((entry) =>
    entry.path.startsWith(".diligent/sessions/"),
  );
  const verifier = input.verifier;
  if (
    canonical(input.workspace.initial.entries) !== canonical(initial) ||
    canonical(finalProject) !== canonical(expectedFinal) ||
    canonical(input.workspace.final.entries.map((entry) => entry.path)) !== canonical(expectedFinalPaths) ||
    finalSessionEntries.length !== 2 ||
    finalSessionEntries.some(
      (entry) =>
        entry.kind !== "file" ||
        entry.executable !== false ||
        !entry.sha256 ||
        entry.sha256.length !== 64 ||
        entry.size <= 0,
    ) ||
    canonical(input.workspace.final.entries.find((entry) => entry.path === ".diligent/.gitignore")) !==
      canonical({
        path: ".diligent/.gitignore",
        kind: "file",
        size: 131,
        sha256: "ae540b59e8f0f170d1ee7df984f722e9a8b5d01ddd0fda5d969d9dd8ec91b671",
        executable: false,
      }) ||
    unexpectedProject ||
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
    input.runtimeState.diff.some((change) => !["infrastructure", "sessions"].includes(change.category))
  )
    return fail("isolation", "Workspace, verifier, runtime state, or isolation evidence diverged.");
}

function fixtureEntries(world: CustomAgentRoutingWorld): RuntimeWorldSnapshot["entries"] {
  return [
    { path: ".diligent", kind: "directory", size: 0 },
    { path: ".diligent/agents", kind: "directory", size: 0 },
    { path: `.diligent/agents/${DECOY_AGENT}`, kind: "directory", size: 0 },
    {
      path: world.decoyAgent.path,
      kind: "file",
      size: Buffer.byteLength(world.decoyAgent.content),
      sha256: world.decoyAgent.hash,
      executable: false,
    },
    { path: `.diligent/agents/${RELEASE_AGENT}`, kind: "directory", size: 0 },
    {
      path: world.releaseAgent.path,
      kind: "file",
      size: Buffer.byteLength(world.releaseAgent.content),
      sha256: world.releaseAgent.hash,
      executable: false,
    },
    { path: "vault", kind: "directory", size: 0 },
    {
      path: DECOY_PATH,
      kind: "file",
      size: Buffer.byteLength(`${world.decoyToken}\n`),
      sha256: world.decoySourceHash,
      executable: false,
    },
    {
      path: RELEASE_PATH,
      kind: "file",
      size: Buffer.byteLength(world.expected),
      sha256: world.releaseSourceHash,
      executable: false,
    },
  ].sort((left, right) => left.path.localeCompare(right.path)) as RuntimeWorldSnapshot["entries"];
}

function artifactEntry(world: CustomAgentRoutingWorld) {
  return {
    path: ARTIFACT_PATH,
    kind: "file" as const,
    size: Buffer.byteLength(world.expected),
    sha256: world.expectedHash,
    executable: false,
  };
}

function validateFinal(input: RuntimeEvalExecution<CustomAgentRoutingWorld>) {
  const final = input.turns[0]!.messages.at(-1);
  if (
    !final ||
    final.role !== "assistant" ||
    !exactTextWithThinking(final.content, FINAL_RESPONSE) ||
    JSON.stringify(final).includes(input.world.releaseToken) ||
    JSON.stringify(final).includes(input.world.decoyToken)
  )
    return fail("final", "Expected the exact terse final response without fact leakage.");
}

function exactTextWithThinking(content: unknown, text: string): boolean {
  return textFromThinkingContent(content) === text;
}

function childReportText(input: RuntimeEvalExecution<CustomAgentRoutingWorld>): string | undefined {
  const child = input.childSessions[0];
  const final = child ? sessionMessage(child.lines.at(-1)) : undefined;
  return final?.role === "assistant" ? textFromThinkingContent(final.content) : undefined;
}

function exactChildReport(report: string, world: CustomAgentRoutingWorld): boolean {
  const capsuleTokens = report.match(/RELEASE_CAPSULE_[A-Za-z0-9]+/g) ?? [];
  return (
    report.length >= world.releaseToken.length &&
    report.length <= 1_000 &&
    capsuleTokens.length >= 1 &&
    capsuleTokens.length <= 4 &&
    capsuleTokens.every((token) => token === world.releaseToken) &&
    ![world.decoyToken, DECOY_PATH, DECOY_AGENT, "incident"].some((value) =>
      report.toLowerCase().includes(value.toLowerCase()),
    )
  );
}

function textFromThinkingContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const textBlocks = content.filter((block) => isRecord(block) && block.type === "text");
  if (
    textBlocks.length !== 1 ||
    !isRecord(textBlocks[0]) ||
    canonical(Object.keys(textBlocks[0]).sort()) !== canonical(["text", "type"]) ||
    typeof textBlocks[0].text !== "string" ||
    !content.every((block) => (isRecord(block) && block.type === "text" ? true : exactThinkingBlock(block)))
  )
    return undefined;
  return textBlocks[0].text;
}

function exactThinkingBlock(block: unknown): boolean {
  if (!isRecord(block) || block.type !== "thinking" || typeof block.thinking !== "string") return false;
  const allowedKeys = ["providerState", "signature", "thinking", "type"];
  if (Object.keys(block).some((key) => !allowedKeys.includes(key))) return false;
  if (block.signature !== undefined && typeof block.signature !== "string") return false;
  if (block.providerState === undefined) return true;
  if (!isRecord(block.providerState)) return false;
  return (
    canonical(Object.keys(block.providerState).sort()) === canonical(["encryptedContent", "itemId", "provider"]) &&
    (block.providerState.provider === "openai" || block.providerState.provider === "chatgpt") &&
    typeof block.providerState.itemId === "string" &&
    typeof block.providerState.encryptedContent === "string"
  );
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
  return typeof value === "object" && value !== null;
}

const CUSTOM_AGENT_FAILURE_DIMENSIONS = {
  trace_order: "behavior",
  trace_contract: "runtime_policy",
  decoy_access: "runtime_policy",
  isolation: "runtime_policy",
  final: "semantic_goal",
} as const satisfies Record<string, EvalDimension>;

function fail(code: keyof typeof CUSTOM_AGENT_FAILURE_DIMENSIONS, message: string) {
  return {
    passed: false as const,
    code: `custom_agent_routing.${code}`,
    message,
    dimension: CUSTOM_AGENT_FAILURE_DIMENSIONS[code],
  };
}

export const CUSTOM_AGENT_ROUTING_TOOL_CALL_IDS = {
  spawn: SPAWN_CALL_ID,
  read: READ_CALL_ID,
  wait: WAIT_CALL_ID,
  write: WRITE_CALL_ID,
} as const;
