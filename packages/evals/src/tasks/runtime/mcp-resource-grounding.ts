// @summary Behavioral runtime eval for grounding an exact artifact in one discovered stdio MCP resource

import { readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DiligentServerRequestResponse } from "@diligent/protocol";
import { createPermissionEngine } from "@diligent/runtime";
import { getMcpManager } from "@diligent/runtime/tools";
import type { RuntimeEvalExecution, RuntimeEvalTask } from "../../runtime-task";
import type { EvalDimension } from "../../task";
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

const SERVER = "fixture-reference";
const ENTRY_PATH = "mcp/server.js";
const PACKAGE_PATH = "package.json";
const MANIFEST_PATH = "manifest.json";
const KEEP_PATH = ".git/.keep";
const ARTIFACT_PATH = "grounded-answer.txt";
const CLOSE_MARKER_PATH = ".mcp-closed";
const UNEXPECTED_MARKER_PATH = ".mcp-unexpected-access";
const STARTUP_TIMEOUT_MS = 5_000;
const TOOL_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_TOKENS = 1_337;
const FINAL_RESPONSE = "GROUNDING_COMPLETE";

interface ResourceRecord {
  uri: string;
  name: string;
  description: string;
  mimeType: "text/plain";
}

interface RuntimeConfigRecord {
  serverNames: string[];
  command: string;
  args: string[];
  cwd: string;
  type: string;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  toolLoading: string;
  lazyThreshold: number;
  maxOutputTokens: number;
  resources: boolean;
  prompts: boolean;
}

export interface McpResourceGroundingWorld extends RuntimeFixtureWorld {
  serverName: string;
  fact: string;
  decoyFacts: string[];
  intendedUri: string;
  resourceUris: string[];
  resources: ResourceRecord[];
  clientPrompt: string;
  finalResponse: string;
  artifactPath: string;
  expectedHash: string;
  entryPath: string;
  closeMarkerPath: string;
  unexpectedMarkerPath: string;
  entryContent: string;
  entryHash: string;
  packageContent: string;
  packageHash: string;
  manifestContent: string;
  manifestHash: string;
  runtimeConfigs: RuntimeConfigRecord[];
}

export const mcpResourceGroundingTask: RuntimeEvalTask<McpResourceGroundingWorld> = {
  id: "mcp-resource-grounding",
  description: "Discover one fixture-local MCP resource among decoys and ground an exact artifact in its hidden fact.",
  fixtureVersion: "mcp-resource-grounding-v2",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 4,
    maxToolCalls: 5,
    maxChangedFiles: 1,
    maxChangedBytes: 25,
    timeoutMs: 180_000,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["mcp_list_resources", "mcp_read_resource", "apply_patch", "edit"],
    allowedCapabilities: ["execute", "write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const fixture = fixtureFor(seed, root);
    await writeFixture(root, {
      [ENTRY_PATH]: fixture.entryContent,
      [PACKAGE_PATH]: fixture.packageContent,
      [MANIFEST_PATH]: fixture.manifestContent,
      [KEEP_PATH]: "fixture boundary\n",
    });
    return {
      root,
      seed,
      protectedPaths: [ENTRY_PATH, PACKAGE_PATH, MANIFEST_PATH, KEEP_PATH],
      allowedChanges: [ARTIFACT_PATH],
      ...fixture,
      runtimeConfigs: [],
    };
  },
  async createRuntimeConfig(world, profile) {
    const config = await createIsolatedFixtureRuntimeConfig(world, profile);
    const server = {
      type: "stdio" as const,
      command: process.execPath,
      args: [world.entryPath],
      cwd: world.root,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      toolTimeoutMs: TOOL_TIMEOUT_MS,
    };
    config.diligent.mcpServers = { [SERVER]: server };
    config.diligent.mcp = {
      toolLoading: "eager",
      lazyThreshold: 10,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      resources: true,
      prompts: false,
    };
    config.permissionEngine = createPermissionEngine([{ permission: "write", pattern: "**", action: "allow" }]);
    world.runtimeConfigs.push({
      serverNames: Object.keys(config.diligent.mcpServers),
      command: server.command,
      args: [...server.args],
      cwd: server.cwd,
      type: server.type,
      startupTimeoutMs: server.startupTimeoutMs,
      toolTimeoutMs: server.toolTimeoutMs,
      toolLoading: config.diligent.mcp.toolLoading!,
      lazyThreshold: config.diligent.mcp.lazyThreshold!,
      maxOutputTokens: config.diligent.mcp.maxOutputTokens!,
      resources: config.diligent.mcp.resources!,
      prompts: config.diligent.mcp.prompts!,
    });
    return config;
  },
  createSteps: (world) => [{ kind: "turn", mode: "default", message: world.clientPrompt }],
  respondToServerRequest(_world, request): DiligentServerRequestResponse {
    if (request.method !== "approval/request") throw new Error(`Unexpected server request: ${request.method}`);
    const approval = request.params.request;
    if (approval.permission !== "execute" || approval.toolName !== "mcp_read_resource")
      throw new Error("Unexpected approval request.");
    return { method: request.method, result: { decision: "once" } };
  },
  verify: (world, signal) => verifyExactFiles(world, { [ARTIFACT_PATH]: world.expected }, signal),
  snapshotWorld: async (world) => ({
    artifact: await exactFile(world.root, ARTIFACT_PATH),
    artifactHash: sha256Text((await exactFile(world.root, ARTIFACT_PATH)) ?? ""),
    entryHash: sha256Text(await readFile(world.entryPath, "utf8")),
    packageHash: sha256Text(await readFile(join(world.root, PACKAGE_PATH), "utf8")),
    manifestHash: sha256Text(await readFile(join(world.root, MANIFEST_PATH), "utf8")),
    closeMarkerAbsent: !(await fileExists(world.closeMarkerPath)),
    unexpectedMarkerAbsent: !(await fileExists(world.unexpectedMarkerPath)),
    runtimeConfigs: world.runtimeConfigs,
  }),
  evaluate(input) {
    const failure = validateTraceAndApproval(input) ?? validateIsolationAndFinal(input);
    if (failure) return failure;
    const extraDiscovery = input.toolCalls.filter((call) => call.name === "mcp_list_resources").length - 1;
    const recoveries = input.toolCalls.filter((call) => call.outcome === "runtime_error").length;
    const diagnostics = [
      ...(extraDiscovery > 0
        ? [
            {
              dimension: "efficiency" as const,
              code: "mcp_resource.additional_safe_discovery",
              message: `${extraDiscovery} additional bounded resource listing${extraDiscovery === 1 ? "" : "s"} preceded the intended read.`,
            },
          ]
        : []),
      ...(recoveries > 0
        ? [
            {
              dimension: "efficiency" as const,
              code: "mcp_resource.bounded_write_recovery",
              message: `${recoveries} bounded artifact-write recovery attempt${recoveries === 1 ? "" : "s"} preceded success.`,
            },
          ]
        : []),
    ];
    return diagnostics.length > 0 ? { passed: true, diagnostics } : { passed: true };
  },
  async cleanup(world) {
    await getMcpManager().disposeAll();
    const deadline = Date.now() + 900;
    while (!(await fileExists(world.closeMarkerPath)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(await fileExists(world.closeMarkerPath)))
      throw new Error("Fixture MCP process did not write its close marker.");
    await unlink(world.closeMarkerPath);
  },
};

function fixtureFor(seed: string, root: string) {
  const fact = seededToken(seed, "GROUNDED_FACT");
  const decoyFacts = [seededToken(seed, "ARCHIVE_DECOY"), seededToken(seed, "TERRESTRIAL_DECOY")];
  const intendedUri = uriFor(seed, "PRIMARY_REFERENCE");
  const resourceUris = [intendedUri, uriFor(seed, "ARCHIVE_REFERENCE"), uriFor(seed, "TERRESTRIAL_REFERENCE")];
  const resources: ResourceRecord[] = [
    {
      uri: resourceUris[0]!,
      name: "Current orbital relay handoff authorization",
      description: "Authorization reference for the current orbital relay handoff.",
      mimeType: "text/plain",
    },
    {
      uri: resourceUris[1]!,
      name: "Archived orbital relay handoff schedule",
      description: "Prior-cycle scheduling reference for an archived orbital relay handoff.",
      mimeType: "text/plain",
    },
    {
      uri: resourceUris[2]!,
      name: "Current terrestrial relay handoff authorization",
      description: "Authorization reference for a current terrestrial relay handoff.",
      mimeType: "text/plain",
    },
  ];
  const expected = `${fact}\n`;
  const clientPrompt =
    "Discover the connected reference material for the current orbital relay handoff. Identify the uniquely relevant " +
    `reference and create ${ARTIFACT_PATH} containing only its authorization value followed by one newline. ` +
    `Reply with exactly ${FINAL_RESPONSE}.`;
  const packageContent = `${JSON.stringify({ name: "diligent-mcp-resource-fixture", private: true, type: "module" }, null, 2)}\n`;
  const manifestContent = `${JSON.stringify({ fixture: "mcp-resource-grounding", resources: resources.length }, null, 2)}\n`;
  const entryPath = join(root, ENTRY_PATH);
  const closeMarkerPath = join(root, CLOSE_MARKER_PATH);
  const unexpectedMarkerPath = join(root, UNEXPECTED_MARKER_PATH);
  const entryContent = serverSource({ resources, fact, decoyFacts });
  return {
    serverName: SERVER,
    fact,
    decoyFacts,
    intendedUri,
    resourceUris,
    resources,
    clientPrompt,
    finalResponse: FINAL_RESPONSE,
    artifactPath: ARTIFACT_PATH,
    expected,
    expectedHash: sha256Text(expected),
    entryPath,
    closeMarkerPath,
    unexpectedMarkerPath,
    entryContent,
    entryHash: sha256Text(entryContent),
    packageContent,
    packageHash: sha256Text(packageContent),
    manifestContent,
    manifestHash: sha256Text(manifestContent),
  };
}

function uriFor(seed: string, prefix: string): string {
  return `fixture://reference/${seededToken(seed, prefix).toLowerCase()}`;
}

function serverSource(input: { resources: ResourceRecord[]; fact: string; decoyFacts: string[] }): string {
  const runtimeModules = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../runtime/node_modules");
  const sdk = pathToFileURL(join(runtimeModules, "@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href;
  const stdio = pathToFileURL(join(runtimeModules, "@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href;
  const zod = import.meta.resolve("zod");
  return `import { appendFileSync, writeFileSync } from "node:fs";
import { McpServer } from ${JSON.stringify(sdk)};
import { StdioServerTransport } from ${JSON.stringify(stdio)};
import { z } from ${JSON.stringify(zod)};

const closeMarker = ${JSON.stringify(CLOSE_MARKER_PATH)};
const unexpectedMarker = ${JSON.stringify(UNEXPECTED_MARKER_PATH)};
process.on("exit", () => { try { writeFileSync(closeMarker, "closed\\n"); } catch {} });
const markUnexpected = (label) => appendFileSync(unexpectedMarker, label + "\\n");
const server = new McpServer({ name: "diligent-eval-resource-grounding", version: "1.0.0" });
server.registerTool("fixture_health_probe", { description: "Fixture transport health probe.", inputSchema: { nonce: z.string().optional() } }, async () => ({ content: [{ type: "text", text: "HEALTHY" }] }));
const resources = ${JSON.stringify(input.resources)};
server.registerResource(resources[0].name, resources[0].uri, { description: resources[0].description, mimeType: resources[0].mimeType }, async (uri) => {
  if (uri.href !== resources[0].uri) { markUnexpected(uri.href); throw new Error("UNEXPECTED_RESOURCE_ACCESS:" + uri.href); }
  return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Orbital relay handoff authorization value: ${input.fact}" }] };
});
server.registerResource(resources[1].name, resources[1].uri, { description: resources[1].description, mimeType: resources[1].mimeType }, async (uri) => {
  markUnexpected("archive:" + uri.href);
  return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Archived orbital relay handoff schedule value: ${input.decoyFacts[0]}" }] };
});
server.registerResource(resources[2].name, resources[2].uri, { description: resources[2].description, mimeType: resources[2].mimeType }, async (uri) => {
  markUnexpected("terrestrial:" + uri.href);
  return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Terrestrial relay handoff authorization value: ${input.decoyFacts[1]}" }] };
});
await server.connect(new StdioServerTransport());
`;
}

function validateTraceAndApproval(input: RuntimeEvalExecution<McpResourceGroundingWorld>) {
  const lists = input.toolCalls.filter((call) => call.name === "mcp_list_resources");
  const reads = input.toolCalls.filter((call) => call.name === "mcp_read_resource");
  const writes = input.toolCalls.filter((call) => call.name === "edit" || call.name === "apply_patch");
  const read = reads.find((call) => call.outcome === "success");
  const write = writes.findLast((call) => call.outcome === "success");
  const callIds = input.toolCalls.map((call) => call.toolCallId);
  const traceChecks: Array<[string, boolean]> = [
    [
      "cardinality",
      input.toolCalls.length < 3 ||
        input.toolCalls.length > 5 ||
        lists.length < 1 ||
        reads.length !== 1 ||
        writes.length < 1 ||
        writes.length > 2 ||
        !read ||
        !write,
    ],
    [
      "names",
      input.toolCalls.some(
        (call) => !["mcp_list_resources", "mcp_read_resource", "edit", "apply_patch"].includes(call.name),
      ),
    ],
    [
      "linkage",
      input.toolCalls.some(
        (call, index) =>
          call.sequence !== index + 1 ||
          call.threadId !== input.session.threadId ||
          call.childThreadId !== undefined ||
          call.outcome === "policy_rejection" ||
          (call.outcome === "runtime_error" && !writes.includes(call)),
      ),
    ],
    [
      "call-ids",
      callIds.some((callId) => typeof callId !== "string" || callId.length === 0) ||
        new Set(callIds).size !== callIds.length,
    ],
    ["list-input", lists.some((list) => !hasExpectedListInput(list.input) || list.outcome !== "success")],
    ["read-input", canonicalJson(read?.input) !== canonicalJson({ server: SERVER, uri: input.world.intendedUri })],
    [
      "order",
      !read ||
        !write ||
        lists.some((list) => list.sequence >= read.sequence) ||
        read.sequence >= write.sequence ||
        writes.some((attempt) => attempt.outcome === "runtime_error" && attempt.sequence >= write.sequence),
    ],
    ["write-input", !targetsArtifact(write?.input)],
    [
      "capabilities",
      lists.some((list) => list.capability !== "execute") ||
        read?.capability !== "execute" ||
        writes.some((attempt) => attempt.capability !== "write" || !targetsArtifact(attempt.input)),
    ],
  ];
  const failedTraceCheck = traceChecks.find(([, failed]) => failed)?.[0];
  if (failedTraceCheck)
    return fail(
      "trace",
      `List/read/write order, actors, capabilities, or exact target inputs diverged: ${failedTraceCheck}`,
    );
}

function hasExpectedListInput(value: unknown): boolean {
  return canonicalJson(value) === canonicalJson({}) || canonicalJson(value) === canonicalJson({ server: SERVER });
}

function targetsArtifact(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.file_path === "string")
    return value.file_path === ARTIFACT_PATH || value.file_path === `$WORKSPACE/${ARTIFACT_PATH}`;
  if (typeof value.patch !== "string") return false;
  const targets = [...value.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]);
  return targets.length === 1 && targets[0] === ARTIFACT_PATH;
}

function validateIsolationAndFinal(input: RuntimeEvalExecution<McpResourceGroundingWorld>) {
  const report = JSON.stringify(input.toolCalls);
  if (input.verifier?.timedOut) return fail("verifier_timeout", "The independent artifact verifier timed out.");
  if (input.verifier?.exitCode !== 0) return fail("verifier", "The independent artifact verifier failed.");
  const artifact = input.workspace.final.entries.find((entry) => entry.path === input.world.artifactPath);
  if (artifact?.sha256 !== input.world.expectedHash)
    return fail("artifact", "The grounded artifact bytes were incorrect.");
  if (
    input.toolOutputFiles.length !== 0 ||
    input.childSessions.length !== 0 ||
    input.compactions.length !== 0 ||
    input.protocolActions.length !== 0 ||
    input.userInputRequests.length !== 0 ||
    input.runtimeState.diff.some((change) => change.category !== "infrastructure" && change.category !== "sessions") ||
    input.world.decoyFacts.some((fact) => report.includes(fact)) ||
    input.world.resourceUris.slice(1).some((uri) => readUriOccurrences(input, uri) > 0) ||
    readUriOccurrences(input, input.world.intendedUri) !== 1 ||
    !hasExactFinal(
      input.turns[0]!.messages.findLast((message) => message.role === "assistant"),
      FINAL_RESPONSE,
    )
  )
    return fail(
      "isolation",
      "Forbidden state, decoy access/content, extra read, log, action, child, or final text appeared.",
    );
}

function readUriOccurrences(input: RuntimeEvalExecution<McpResourceGroundingWorld>, uri: string): number {
  return input.toolCalls.filter(
    (call) => call.name === "mcp_read_resource" && isRecord(call.input) && call.input.uri === uri,
  ).length;
}

function hasExactFinal(value: unknown, text: string): boolean {
  if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content) || value.content.length !== 1)
    return false;
  const block = value.content[0];
  return (
    isRecord(block) &&
    Object.keys(block).sort().join(",") === "text,type" &&
    block.type === "text" &&
    block.text === text
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MCP_RESOURCE_FAILURE_DIMENSIONS = {
  verifier: "format_contract",
  verifier_timeout: "harness_terminal",
  isolation: "runtime_policy",
  trace: "runtime_policy",
  artifact: "format_contract",
} as const satisfies Record<string, EvalDimension>;

function fail(code: keyof typeof MCP_RESOURCE_FAILURE_DIMENSIONS, message: string) {
  return {
    passed: false as const,
    code: `mcp_resource.${code}`,
    message,
    dimension: MCP_RESOURCE_FAILURE_DIMENSIONS[code],
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
