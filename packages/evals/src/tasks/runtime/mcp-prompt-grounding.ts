// @summary Behavioral runtime eval for grounding an exact artifact in one discovered stdio MCP prompt

import { readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DiligentServerRequestResponse } from "@diligent/protocol";
import { createPermissionEngine } from "@diligent/runtime";
import { getMcpManager } from "@diligent/runtime/tools";
import type { RuntimeEvalExecution, RuntimeEvalTask, RuntimeToolTrace } from "../../runtime-task";
import type { EvalDimension } from "../../task";
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

const SERVER = "fixture-workflows";
const ENTRY_PATH = "mcp/server.js";
const PACKAGE_PATH = "package.json";
const MANIFEST_PATH = "manifest.json";
const KEEP_PATH = ".git/.keep";
const ARTIFACT_PATH = "orbital-workflow.txt";
const CLOSE_MARKER_PATH = ".mcp-closed";
const UNEXPECTED_MARKER_PATH = ".mcp-unexpected-access";
const STARTUP_TIMEOUT_MS = 5_000;
const TOOL_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_TOKENS = 1_337;
const FINAL_RESPONSE = "ORBITAL_WORKFLOW_COMPLETE";

interface PromptArgumentRecord {
  name: string;
  description: string;
  required: true;
}

interface PromptRecord {
  name: string;
  description: string;
  arguments: PromptArgumentRecord[];
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

export interface McpPromptGroundingWorld extends RuntimeFixtureWorld {
  serverName: string;
  fact: string;
  decoyFacts: string[];
  intendedName: string;
  promptNames: string[];
  prompts: PromptRecord[];
  argumentNames: [string, string];
  argumentValues: [string, string];
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

export const mcpPromptGroundingTask: RuntimeEvalTask<McpPromptGroundingWorld> = {
  id: "mcp-prompt-grounding",
  description: "Discover one fixture-local MCP prompt among decoys and ground an exact artifact in its hidden fact.",
  fixtureVersion: "mcp-prompt-grounding-v2",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 5,
    maxToolCalls: 4,
    maxChangedFiles: 1,
    maxChangedBytes: 24,
    timeoutMs: 180_000,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["mcp_list_prompts", "mcp_get_prompt", "apply_patch", "edit"],
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
      resources: false,
      prompts: true,
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
    if (approval.permission !== "execute" || approval.toolName !== "mcp_get_prompt")
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
    return input.toolCalls.some((call) => call.outcome === "runtime_error")
      ? {
          passed: true,
          diagnostics: [
            {
              dimension: "efficiency",
              code: "mcp_prompt.bounded_write_recovery",
              message: "One bounded provider-native write recovery preceded the exact artifact write.",
            },
          ],
        }
      : { passed: true };
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
  const fact = seededToken(seed, "ORBITAL_FACT");
  const decoyFacts = [seededToken(seed, "ARCHIVE_DECOY"), seededToken(seed, "TERRESTRIAL_DECOY")];
  const argumentNames: [string, string] = ["relay_designator", "handoff_window"];
  const argumentValues: [string, string] = [seededToken(seed, "RELAY_DESIGNATOR"), seededToken(seed, "HANDOFF_WINDOW")];
  const intendedName = "current-orbital-handoff";
  const promptNames = [intendedName, "archived-orbital-handoff", "current-terrestrial-handoff"];
  const orbitalArguments: PromptArgumentRecord[] = [
    { name: argumentNames[0], description: "Seeded relay designator from the workflow request.", required: true },
    { name: argumentNames[1], description: "Seeded handoff window from the workflow request.", required: true },
  ];
  const prompts: PromptRecord[] = [
    {
      name: promptNames[0]!,
      description: "Execute the current orbital relay handoff workflow for a supplied relay and window.",
      arguments: orbitalArguments,
    },
    {
      name: promptNames[1]!,
      description: "Execute an archived orbital relay handoff workflow for a supplied relay and window.",
      arguments: orbitalArguments.map((argument) => ({ ...argument })),
    },
    {
      name: promptNames[2]!,
      description: "Execute the current terrestrial relay handoff workflow for a supplied relay and window.",
      arguments: orbitalArguments.map((argument) => ({ ...argument })),
    },
  ];
  const expected = `${fact}\n`;
  const clientPrompt =
    `Please carry out the connected current orbital relay handoff workflow for relay designator ${argumentValues[0]} ` +
    `during handoff window ${argumentValues[1]}.`;
  const packageContent = `${JSON.stringify({ name: "diligent-mcp-prompt-fixture", private: true, type: "module" }, null, 2)}\n`;
  const manifestContent = `${JSON.stringify({ fixture: "mcp-prompt-grounding", prompts: prompts.length }, null, 2)}\n`;
  const entryPath = join(root, ENTRY_PATH);
  const closeMarkerPath = join(root, CLOSE_MARKER_PATH);
  const unexpectedMarkerPath = join(root, UNEXPECTED_MARKER_PATH);
  const entryContent = serverSource({ prompts, fact, decoyFacts, argumentNames, argumentValues });
  return {
    serverName: SERVER,
    fact,
    decoyFacts,
    intendedName,
    promptNames,
    prompts,
    argumentNames,
    argumentValues,
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

function serverSource(input: {
  prompts: PromptRecord[];
  fact: string;
  decoyFacts: string[];
  argumentNames: [string, string];
  argumentValues: [string, string];
}): string {
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
const server = new McpServer({ name: "diligent-eval-prompt-grounding", version: "1.0.0" });
server.registerTool("fixture_health_probe", { description: "Fixture transport health probe.", inputSchema: { nonce: z.string().optional() } }, async () => ({ content: [{ type: "text", text: "HEALTHY" }] }));
const prompts = ${JSON.stringify(input.prompts)};
const expectedArgs = ${JSON.stringify(Object.fromEntries(input.argumentNames.map((name, index) => [name, input.argumentValues[index]])))};
const argsSchema = {
  ${input.argumentNames[0]}: z.string().describe(prompts[0].arguments[0].description),
  ${input.argumentNames[1]}: z.string().describe(prompts[0].arguments[1].description),
};
const exactArgs = (args) => Object.keys(args).length === 2 && Object.entries(expectedArgs).every(([key, value]) => args[key] === value);
server.registerPrompt(prompts[0].name, { description: prompts[0].description, argsSchema }, async (args) => {
  if (!exactArgs(args)) { markUnexpected("wrong-args:" + JSON.stringify(args)); throw new Error("UNEXPECTED_PROMPT_ARGUMENTS"); }
  return {
    description: "Current orbital relay workflow instructions",
    messages: [{ role: "user", content: { type: "text", text: "Create ${ARTIFACT_PATH} containing only ${input.fact} followed by one newline, then reply exactly ${FINAL_RESPONSE}." } }],
  };
});
server.registerPrompt(prompts[1].name, { description: prompts[1].description, argsSchema }, async (args) => {
  markUnexpected("archive:" + JSON.stringify(args));
  return { description: "Archived orbital workflow", messages: [{ role: "user", content: { type: "text", text: "Archived orbital value: ${input.decoyFacts[0]}" } }] };
});
server.registerPrompt(prompts[2].name, { description: prompts[2].description, argsSchema }, async (args) => {
  markUnexpected("terrestrial:" + JSON.stringify(args));
  return { description: "Current terrestrial workflow", messages: [{ role: "user", content: { type: "text", text: "Current terrestrial value: ${input.decoyFacts[1]}" } }] };
});
await server.connect(new StdioServerTransport());
`;
}

function validateTraceAndApproval(input: RuntimeEvalExecution<McpPromptGroundingWorld>) {
  const [list, get] = input.toolCalls;
  const writeAttempts = input.toolCalls.slice(2);
  const write = writeAttempts.at(-1);
  const recovery = writeAttempts.length === 2 ? writeAttempts[0] : undefined;
  const writeTool = input.profile.provider === "anthropic" ? "edit" : "apply_patch";
  const exactArgs = Object.fromEntries(
    input.world.argumentNames.map((name, index) => [name, input.world.argumentValues[index]]),
  );
  const callIds = input.toolCalls.map((call) => call.toolCallId);
  const traceChecks: Array<[string, boolean]> = [
    ["cardinality", (input.toolCalls.length !== 3 && input.toolCalls.length !== 4) || !list || !get || !write],
    [
      "names",
      canonicalJson(input.toolCalls.map((call) => call.name)) !==
        canonicalJson(["mcp_list_prompts", "mcp_get_prompt", ...writeAttempts.map(() => writeTool)]),
    ],
    [
      "linkage",
      input.toolCalls.some(
        (call, index) =>
          call.sequence !== index + 1 ||
          call.threadId !== input.session.threadId ||
          call.childThreadId !== undefined ||
          (call !== recovery && (call.outcome !== "success" || call.error !== undefined)),
      ),
    ],
    [
      "call-ids",
      callIds.some((callId) => typeof callId !== "string" || callId.length === 0) ||
        new Set(callIds).size !== callIds.length,
    ],
    ["list-input", !hasExpectedListInput(list?.input)],
    [
      "get-input",
      canonicalJson(get?.input) !==
        canonicalJson({ server: SERVER, name: input.world.intendedName, args: exactArgs }) ||
        !hasExactArgumentOrder(get?.input, input.world),
    ],
    ["write-input", !hasExpectedWriteInput(write?.input, input)],
    [
      "capabilities",
      list?.capability !== "execute" ||
        get?.capability !== "execute" ||
        writeAttempts.some((attempt) => attempt.capability !== "write"),
    ],
    ["recovery", recovery !== undefined && !hasExpectedWriteRecovery(recovery, input)],
  ];
  const failedTraceCheck = traceChecks.find(([, failed]) => failed)?.[0];
  if (failedTraceCheck)
    return fail(
      "trace",
      `List/get/write order, actors, capabilities, or exact target inputs diverged: ${failedTraceCheck}`,
    );
}

function hasExpectedWriteRecovery(
  trace: RuntimeToolTrace,
  input: RuntimeEvalExecution<McpPromptGroundingWorld>,
): boolean {
  const relativePathError = `Error: file_path must be absolute: ${ARTIFACT_PATH}`;
  const absolutePath = `$WORKSPACE/${ARTIFACT_PATH}`;
  const missingFileError = `Error reading file: ENOENT: no such file or directory, open '${absolutePath}'`;
  const relativePathInput =
    canonicalJson(trace.input) ===
    canonicalJson({
      file_path: ARTIFACT_PATH,
      old_string: "",
      new_string: input.world.expected,
      replace_all: false,
    });
  const missingFileInput =
    isRecord(trace.input) &&
    trace.input.file_path === absolutePath &&
    typeof trace.input.old_string === "string" &&
    trace.input.old_string.length > 0 &&
    trace.input.old_string.length <= 256 &&
    trace.input.new_string === input.world.expected &&
    trace.input.replace_all === false &&
    Object.keys(trace.input).sort().join(",") === "file_path,new_string,old_string,replace_all";
  const expectedError = relativePathInput ? relativePathError : missingFileInput ? missingFileError : undefined;
  return (
    input.profile.provider === "anthropic" &&
    trace.name === "edit" &&
    trace.outcome === "runtime_error" &&
    expectedError !== undefined &&
    trace.error === expectedError &&
    canonicalJson(trace.output) === canonicalJson({ output: expectedError, metadata: { error: true } })
  );
}

function hasExactArgumentOrder(value: unknown, world: McpPromptGroundingWorld): boolean {
  return (
    isRecord(value) &&
    isRecord(value.args) &&
    canonicalJson(Object.keys(value.args)) === canonicalJson(world.argumentNames)
  );
}

function expectedPatch(world: McpPromptGroundingWorld): string {
  return `*** Begin Patch\n*** Add File: ${ARTIFACT_PATH}\n+${world.fact}\n*** End Patch`;
}

function expectedWriteInput(input: RuntimeEvalExecution<McpPromptGroundingWorld>) {
  return input.profile.provider === "anthropic"
    ? {
        file_path: `$WORKSPACE/${ARTIFACT_PATH}`,
        old_string: "",
        new_string: input.world.expected,
        replace_all: false,
      }
    : { patch: expectedPatch(input.world) };
}

function hasExpectedListInput(value: unknown): boolean {
  return canonicalJson(value) === canonicalJson({}) || canonicalJson(value) === canonicalJson({ server: SERVER });
}

function hasExpectedWriteInput(value: unknown, input: RuntimeEvalExecution<McpPromptGroundingWorld>): boolean {
  return input.profile.provider === "anthropic"
    ? canonicalJson(value) === canonicalJson(expectedWriteInput(input))
    : matchesExactPatchInput(value, expectedPatch(input.world));
}

function validateIsolationAndFinal(input: RuntimeEvalExecution<McpPromptGroundingWorld>) {
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
    input.world.promptNames.slice(1).some((name) => getPromptOccurrences(input, name) > 0) ||
    getPromptOccurrences(input, input.world.intendedName) !== 1 ||
    !hasExactFinal(input.turns[0]!.messages.at(-1), FINAL_RESPONSE)
  )
    return fail(
      "isolation",
      "Forbidden state, decoy access/content, extra prompt fetch, log, action, child, or final text appeared.",
    );
}

function getPromptOccurrences(input: RuntimeEvalExecution<McpPromptGroundingWorld>, name: string): number {
  return input.toolCalls.filter(
    (call) => call.name === "mcp_get_prompt" && isRecord(call.input) && call.input.name === name,
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

const MCP_PROMPT_FAILURE_DIMENSIONS = {
  verifier: "format_contract",
  verifier_timeout: "harness_terminal",
  isolation: "runtime_policy",
  trace: "runtime_policy",
  artifact: "format_contract",
} as const satisfies Record<string, EvalDimension>;

function fail(code: keyof typeof MCP_PROMPT_FAILURE_DIMENSIONS, message: string) {
  return {
    passed: false as const,
    code: `mcp_prompt.${code}`,
    message,
    dimension: MCP_PROMPT_FAILURE_DIMENSIONS[code],
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
