// @summary Behavioral runtime eval for auto-selected lazy MCP discovery and approved stdio execution

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
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  writeFixture,
} from "./helpers";

const SERVER = "fixture-logistics";
const INTENDED_TOOL = "coordinate_sterile_field_unit";
const DECOY_TOOL = "coordinate_specimen_archive";
const SEARCH_QUERY = "sterile expedition rendezvous";
const ENTRY_PATH = "mcp/server.js";
const MANIFEST_PATH = "manifest.json";
const KEEP_PATH = ".git/.keep";
const CLOSE_MARKER_PATH = ".mcp-closed";
const LAZY_THRESHOLD = 3;
const STARTUP_TIMEOUT_MS = 5_000;
const TOOL_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_TOKENS = 1_337;
const MAX_OUTPUT_BYTES = MAX_OUTPUT_TOKENS * 4;

const INTENDED_DESCRIPTION =
  "Arrange a sterile expedition rendezvous when a case reference, field location, operating window, team roster, and clinical support requirements are known.";

interface FieldUnitRequest {
  case_ref: string;
  deployment: {
    location: { facility: string; region_code: string };
    operating_window: { opens: string; closes: string };
    team: Array<{ badge: string; role: "clinician" | "technician" }>;
  };
  support: { isolation_grade: "negative_pressure" | "standard"; cold_chain: boolean };
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

export interface McpLazyToolWorld extends RuntimeFixtureWorld {
  serverName: string;
  intendedTool: string;
  decoyTool: string;
  searchQuery: string;
  request: FieldUnitRequest;
  receipt: string;
  decoyReceipt: string;
  clientPrompt: string;
  entryPath: string;
  closeMarkerPath: string;
  entryContent: string;
  entryHash: string;
  manifestContent: string;
  manifestHash: string;
  runtimeConfigs: RuntimeConfigRecord[];
}

export const mcpLazyToolTask: RuntimeEvalTask<McpLazyToolWorld> = {
  id: "mcp-lazy-tool",
  description: "Discover one fixture-local stdio MCP tool through auto-selected lazy proxies and run it with approval.",
  fixtureVersion: "mcp-lazy-tool-v4",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 4,
    maxToolCalls: 3,
    maxChangedFiles: 0,
    maxChangedBytes: 0,
    timeoutMs: 180_000,
  },
  statePolicy: { allowedMutations: ["infrastructure", "sessions"] },
  toolPolicy: {
    allowedTools: ["mcp_search_tools", "mcp_run_tool"],
    allowedCapabilities: ["execute"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const fixture = fixtureFor(seed, root);
    await writeFixture(root, {
      [ENTRY_PATH]: fixture.entryContent,
      [MANIFEST_PATH]: fixture.manifestContent,
      [KEEP_PATH]: "fixture boundary\n",
    });
    return {
      root,
      seed,
      expected: fixture.receipt,
      protectedPaths: [ENTRY_PATH, MANIFEST_PATH, KEEP_PATH],
      allowedChanges: [],
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
      toolLoading: "auto",
      lazyThreshold: LAZY_THRESHOLD,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      resources: false,
      prompts: false,
    };
    config.permissionEngine = createPermissionEngine([]);
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
    return { method: request.method, result: { decision: "once" } };
  },
  snapshotWorld: async (world) => ({
    entryHash: sha256Text(await readFile(world.entryPath, "utf8")),
    closeMarkerAbsent: !(await fileExists(world.closeMarkerPath)),
    runtimeConfigs: world.runtimeConfigs,
  }),
  evaluate(input) {
    const failure = validateTraceAndApproval(input) ?? validateIsolation(input) ?? validateFinal(input);
    if (failure) return failure;
    return input.toolCalls.length === 3
      ? {
          passed: true,
          diagnostics: [
            {
              dimension: "efficiency",
              code: "mcp_lazy.second_safe_search",
              message: "A second bounded discovery search preceded the intended MCP call.",
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
  const caseRef = seededToken(seed, "FIELD_CASE");
  const clinician = seededToken(seed, "CLINICIAN");
  const technician = seededToken(seed, "TECHNICIAN");
  const facility = seededToken(seed, "FACILITY");
  const receipt = seededToken(seed, "FIELD_UNIT_RECEIPT");
  const decoyReceipt = seededToken(seed, "ARCHIVE_RECEIPT");
  const request: FieldUnitRequest = {
    case_ref: caseRef,
    deployment: {
      location: { facility, region_code: "KR-41" },
      operating_window: { opens: "2026-10-06", closes: "2026-10-09" },
      team: [
        { badge: clinician, role: "clinician" },
        { badge: technician, role: "technician" },
      ],
    },
    support: { isolation_grade: "negative_pressure", cold_chain: true },
  };
  const clientPrompt =
    `Arrange the mobile clinical unit for case ${caseRef} at ${facility} in KR-41 from 2026-10-06 through ` +
    `2026-10-09. ${clinician} is the clinician and ${technician} is the technician. The unit needs negative-pressure ` +
    "isolation and cold-chain support. Find the appropriate connected service and reply with only its confirmation.";
  const manifestContent = `${JSON.stringify({ fixture: "mcp-field-unit", case: caseRef }, null, 2)}\n`;
  const entryPath = join(root, ENTRY_PATH);
  const closeMarkerPath = join(root, CLOSE_MARKER_PATH);
  const entryContent = serverSource({ request, receipt, decoyReceipt });
  return {
    serverName: SERVER,
    intendedTool: INTENDED_TOOL,
    decoyTool: DECOY_TOOL,
    searchQuery: SEARCH_QUERY,
    request,
    receipt,
    decoyReceipt,
    clientPrompt,
    entryPath,
    closeMarkerPath,
    entryContent,
    entryHash: sha256Text(entryContent),
    manifestContent,
    manifestHash: sha256Text(manifestContent),
  };
}

function serverSource(input: { request: FieldUnitRequest; receipt: string; decoyReceipt: string }): string {
  const runtimeModules = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../runtime/node_modules");
  const sdk = pathToFileURL(join(runtimeModules, "@modelcontextprotocol/sdk/dist/esm/server/mcp.js")).href;
  const stdio = pathToFileURL(join(runtimeModules, "@modelcontextprotocol/sdk/dist/esm/server/stdio.js")).href;
  const zod = import.meta.resolve("zod");
  return `import { writeFileSync } from "node:fs";
import { McpServer } from ${JSON.stringify(sdk)};
import { StdioServerTransport } from ${JSON.stringify(stdio)};
import { z } from ${JSON.stringify(zod)};

const closeMarker = ${JSON.stringify(CLOSE_MARKER_PATH)};
process.on("exit", () => { try { writeFileSync(closeMarker, "closed\\n"); } catch {} });
const server = new McpServer({ name: "diligent-eval-field-unit", version: "1.0.0" });
const strictObject = (shape) => z.object(shape).strict();
const expectedRequest = ${JSON.stringify(input.request)};
const canonical = (value) => Array.isArray(value)
  ? "[" + value.map(canonical).join(",") + "]"
  : value !== null && typeof value === "object"
    ? "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}"
    : JSON.stringify(value);
server.registerTool(${JSON.stringify(INTENDED_TOOL)}, {
  description: ${JSON.stringify(INTENDED_DESCRIPTION)},
  inputSchema: {
    case_ref: z.string(),
    deployment: strictObject({
      location: strictObject({ facility: z.string(), region_code: z.string().regex(/^[A-Z]{2}-[0-9]{2}$/) }),
      operating_window: strictObject({ opens: z.string(), closes: z.string() }),
      team: z.array(strictObject({ badge: z.string(), role: z.enum(["clinician", "technician"]) })).length(2),
    }),
    support: strictObject({ isolation_grade: z.enum(["negative_pressure", "standard"]), cold_chain: z.boolean() }),
  },
  _meta: { "anthropic/maxResultSizeChars": ${MAX_OUTPUT_BYTES} },
}, async (actual) => ({
  content: [{
    type: "text",
    text: canonical(actual) === canonical(expectedRequest) ? ${JSON.stringify(input.receipt)} : "REJECTED_INPUT",
  }],
}));
server.registerTool(${JSON.stringify(DECOY_TOOL)}, { description: "Transfer preserved archive specimens to a repository vault.", inputSchema: { archive_ref: z.string() } }, async () => ({ content: [{ type: "text", text: ${JSON.stringify(input.decoyReceipt)} }] }));
server.registerTool("schedule_remote_lab_inventory", { description: "Count sealed laboratory inventory for remote storage.", inputSchema: { inventory_ref: z.string() } }, async () => ({ content: [{ type: "text", text: "INVENTORY_DECOY" }] }));
server.registerTool("reserve_research_vessel_berth", { description: "Reserve a berth for a research vessel.", inputSchema: { vessel_ref: z.string() } }, async () => ({ content: [{ type: "text", text: "VESSEL_DECOY" }] }));
server.registerTool("dispatch_museum_crate_team", { description: "Dispatch a handling team for museum crates.", inputSchema: { crate_ref: z.string() } }, async () => ({ content: [{ type: "text", text: "MUSEUM_DECOY" }] }));
await server.connect(new StdioServerTransport());
`;
}

function validateTraceAndApproval(input: RuntimeEvalExecution<McpLazyToolWorld>) {
  const trace = splitMcpTrace(input);
  if (!trace) return fail("trace", "Expected one or two searches followed by one exact run.");
  const { searches, run } = trace;
  const searchOutput = expectedSearchOutput();
  if (
    run.sequence !== searches.length + 1 ||
    run.toolCallId.length === 0 ||
    run.name !== "mcp_run_tool" ||
    run.capability !== "execute" ||
    run.threadId !== input.session.threadId ||
    run.childThreadId !== undefined ||
    run.outcome !== "success" ||
    run.error !== undefined ||
    searches.some(
      (search, index) =>
        search.sequence !== index + 1 ||
        search.toolCallId.length === 0 ||
        search.name !== "mcp_search_tools" ||
        search.capability !== "execute" ||
        search.threadId !== input.session.threadId ||
        search.childThreadId !== undefined ||
        search.outcome !== "success" ||
        search.error !== undefined ||
        !hasGroundedSearchInput(search.input, searchOutput),
    ) ||
    new Set([...searches.map((search) => search.toolCallId), run.toolCallId]).size !== searches.length + 1 ||
    canonicalJson(run.input) !== canonicalJson({ server: SERVER, tool: INTENDED_TOOL, args: input.world.request })
  )
    return fail("trace", "Search/run order, call ids, actors, or exact target inputs diverged.");
}

function splitMcpTrace(input: RuntimeEvalExecution<McpLazyToolWorld>) {
  if (input.toolCalls.length !== 2 && input.toolCalls.length !== 3) return undefined;
  const searches = input.toolCalls.slice(0, -1);
  const run = input.toolCalls.at(-1);
  if (!run || searches.length < 1 || searches.length > 2) return undefined;
  return { searches, run };
}

function hasGroundedSearchInput(value: unknown, searchOutput: string): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    (keys.join(",") !== "query" && keys.join(",") !== "query,server") ||
    (value.server !== undefined && value.server !== SERVER)
  )
    return false;
  if (
    typeof value.query !== "string" ||
    value.query !== value.query.trim() ||
    value.query.length === 0 ||
    value.query.length > 128
  )
    return false;
  const haystack = searchOutput.toLowerCase();
  return value.query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .some((term) => term.length >= 3 && haystack.includes(term));
}

function expectedSearchOutput(): string {
  return JSON.stringify(
    [{ server: SERVER, tool: INTENDED_TOOL, description: INTENDED_DESCRIPTION, inputSchema: intendedSchema() }],
    null,
    2,
  );
}

function intendedSchema() {
  return {
    type: "object",
    properties: {
      case_ref: { type: "string" },
      deployment: {
        type: "object",
        properties: {
          location: {
            type: "object",
            properties: {
              facility: { type: "string" },
              region_code: { type: "string", pattern: "^[A-Z]{2}-[0-9]{2}$" },
            },
            required: ["facility", "region_code"],
            additionalProperties: false,
          },
          operating_window: {
            type: "object",
            properties: { opens: { type: "string" }, closes: { type: "string" } },
            required: ["opens", "closes"],
            additionalProperties: false,
          },
          team: {
            type: "array",
            items: {
              type: "object",
              properties: { badge: { type: "string" }, role: { type: "string", enum: ["clinician", "technician"] } },
              required: ["badge", "role"],
              additionalProperties: false,
            },
            minItems: 2,
            maxItems: 2,
          },
        },
        required: ["location", "operating_window", "team"],
        additionalProperties: false,
      },
      support: {
        type: "object",
        properties: {
          isolation_grade: { type: "string", enum: ["negative_pressure", "standard"] },
          cold_chain: { type: "boolean" },
        },
        required: ["isolation_grade", "cold_chain"],
        additionalProperties: false,
      },
    },
    required: ["case_ref", "deployment", "support"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
  };
}

function validateIsolation(input: RuntimeEvalExecution<McpLazyToolWorld>) {
  const report = JSON.stringify([
    input.turns,
    input.providerCalls,
    input.toolCalls,
    input.logs,
    input.session,
    input.threadReads,
  ]);
  if (
    input.toolOutputFiles.length !== 0 ||
    input.childSessions.length !== 0 ||
    input.compactions.length !== 0 ||
    input.protocolActions.length !== 0 ||
    input.userInputRequests.length !== 0 ||
    input.verifier !== undefined ||
    input.runtimeState.diff.some((change) => change.category !== "infrastructure" && change.category !== "sessions") ||
    input.logs.length !== 0 ||
    report.includes(input.world.decoyReceipt) ||
    report.includes("INVENTORY_DECOY") ||
    report.includes("VESSEL_DECOY") ||
    report.includes("MUSEUM_DECOY")
  )
    return fail(
      "isolation",
      "Forbidden state, output, child, action, input, verifier, log, or decoy execution leaked.",
    );
}

function validateFinal(input: RuntimeEvalExecution<McpLazyToolWorld>) {
  if (!hasExactFinal(input.turns[0]!.messages.at(-1), input.world.receipt))
    return fail("final", "The final answer was not only the exact MCP receipt.");
}

function hasExactFinal(value: unknown, receipt: string): boolean {
  if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content) || value.content.length !== 1)
    return false;
  const block = value.content[0];
  return (
    isRecord(block) &&
    Object.keys(block).sort().join(",") === "text,type" &&
    block.type === "text" &&
    block.text === receipt
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

const MCP_LAZY_FAILURE_DIMENSIONS = {
  trace: "runtime_policy",
  isolation: "runtime_policy",
  final: "semantic_goal",
} as const satisfies Record<string, EvalDimension>;

function fail(code: keyof typeof MCP_LAZY_FAILURE_DIMENSIONS, message: string) {
  return { passed: false as const, code: `mcp_lazy.${code}`, message, dimension: MCP_LAZY_FAILURE_DIMENSIONS[code] };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
