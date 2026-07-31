// @summary OVERDARE MCP server runner: re-exposes studio built-in tools as MCP tools (plus
// model-callable `ensure_system_prompt` / `load_skill` bootstrap tools), and bootstrap agents as
// MCP prompts (user-facing slash commands to seed a session), over stdio.

import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "@diligent/core/tool-contract";
import { createLogger } from "@diligent/logging";
import type { BundledToolProvider, ResolvedExperiment } from "@diligent/runtime";
import { loadDiligentConfig, resolveExperimentGates, resolveExperimentStates } from "@diligent/runtime";
import { resolveProjectDirName } from "@diligent/runtime/infrastructure";
import { discoverSkills, extractBody, parseFrontmatter } from "@diligent/runtime/skills";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { OVERDARE_EXPERIMENTS } from "./experiments";
import { configureSidecarLogging } from "./logging";
import type { StudioCatalogSnapshot, StudioPromptDescriptor, StudioToolDescriptor } from "./studio-registry";
import { createRagToolProvider } from "./tools/rag";
import { createStudioRpcToolProvider } from "./tools/studiorpc";
import { createValidatorToolProvider } from "./tools/validator";

const SERVER_INFO = { name: "overdare-ai-agent", version: "0.0.1" } as const;
const logger = createLogger({ scope: "sidecar/mcp" });

/**
 * Server-level guidance surfaced to the client on `initialize`.
 * Also snapshotted into the Studio registry record so the Rust MCP router (P071) forwards the same
 * text without duplicating it.
 */
export const SERVER_INSTRUCTIONS =
  "This server exposes OVERDARE Studio tools. Before doing anything else, call the " +
  '"ensure_system_prompt" tool and follow what it returns — it establishes how to work with ' +
  'OVERDARE. Use the "load_skill" tool to pull in an OVERDARE skill when a task matches one ' +
  "(its available skills are listed in that tool's description).";

export interface McpServerOptions {
  /** Working directory tools resolve project paths against. */
  cwd: string;
  /** Directory containing the runtime bootstrap `skills/` and `agents/`. */
  bootstrapDir: string;
  /** Product-managed global prompt deployed by `overdare-ai-agent init`. */
  systemPromptPath?: string;
  experiments?: ResolvedExperiment[];
}

/** A prompt exposed over MCP (skill / agent / system prompt), loaded lazily. */
interface PromptEntry {
  name: string;
  description: string;
  load: () => Promise<string>;
}

export interface McpRegistries {
  tools: Map<string, Tool>;
  prompts: Map<string, PromptEntry>;
}

/**
 * Studio built-in tool providers exposed over MCP (no `host` -> auto-approve).
 * Includes RAG search (`overdaresearch`, `overdaresearch_deep`); the gateway/analytics
 * providers expose no agent-callable tools (createTools -> []), so they are omitted.
 */
function studioToolProviders(): BundledToolProvider[] {
  return [createStudioRpcToolProvider(), createValidatorToolProvider(), createRagToolProvider()];
}

async function buildToolRegistry(
  cwd: string,
  experiments: readonly ResolvedExperiment[] = [],
): Promise<Map<string, Tool>> {
  const { disabledToolNames } = resolveExperimentGates(experiments);
  const tools = new Map<string, Tool>();
  for (const provider of studioToolProviders()) {
    for (const tool of await provider.createTools({ cwd })) {
      if (disabledToolNames.has(tool.name)) continue;
      tools.set(tool.name, tool);
    }
  }
  return tools;
}

async function buildPromptRegistry(
  bootstrapDir: string,
  experiments: readonly ResolvedExperiment[] = [],
): Promise<Map<string, PromptEntry>> {
  const prompts = new Map<string, PromptEntry>();
  const { disabledAgentNames } = resolveExperimentGates(experiments);

  // The base system prompt and skills are exposed as model-callable tools (ensure_system_prompt /
  // load_skill in buildModelCallableTools), not prompts — Claude Code only surfaces prompts to the user
  // as slash commands, so a prompt could never be fetched by the model that actually needs them.
  // Only agents remain as prompts (a user picks one to seed a session).

  // Bootstrap agents (each AGENT.md body becomes an `agent-<name>` prompt).
  const agentsDir = join(bootstrapDir, "agents");
  let agentEntries: Dirent[] = [];
  try {
    agentEntries = (await readdir(agentsDir, { withFileTypes: true, encoding: "utf8" })) as Dirent[];
  } catch {
    agentEntries = [];
  }
  for (const entry of agentEntries) {
    if (!entry.isDirectory()) continue;
    const agentPath = join(agentsDir, entry.name, "AGENT.md");
    let content: string;
    try {
      content = await readFile(agentPath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(content, agentPath);
    if ("error" in parsed) continue;
    if (disabledAgentNames.has(parsed.frontmatter.name)) continue;
    const promptName = `agent-${parsed.frontmatter.name}`;
    prompts.set(promptName, {
      name: promptName,
      description: parsed.frontmatter.description,
      load: async () => extractBody(content),
    });
  }

  return prompts;
}

/**
 * Skills that are not usable through the MCP surface — they depend on host-only features (e.g. the
 * Knowledge store / record-project-memory handoff) that this server does not expose — so they must
 * not be offered via load_skill.
 */
const MCP_EXCLUDED_SKILLS = new Set(["record-project-memory"]);

/**
 * Model-callable instruction tools. `ensure_system_prompt` reads the product-managed global prompt
 * deployed by init, while `load_skill` reads the runtime bootstrap skills. `load_skill`'s
 * description carries the available skill names so the model knows what it can pull without a
 * separate call. Skills that rely on host-only features unavailable over MCP are filtered out
 * (MCP_EXCLUDED_SKILLS).
 */
async function buildModelCallableTools(
  bootstrapDir: string,
  systemPromptPath: string,
  experiments: readonly ResolvedExperiment[] = [],
): Promise<Tool[]> {
  const skillsDir = join(bootstrapDir, "skills");
  const { skills: discovered } = await discoverSkills({
    cwd: bootstrapDir,
    globalConfigDir: join(bootstrapDir, "__no_global__"),
    additionalPaths: [skillsDir],
  });
  const { disabledSkillNames } = resolveExperimentGates(experiments);
  const skills = discovered.filter(
    (skill) => !MCP_EXCLUDED_SKILLS.has(skill.name) && !disabledSkillNames.has(skill.name),
  );
  const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
  const skillIndex = skills.length
    ? skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")
    : "(no skills available)";

  const ensureSystemPrompt: Tool = {
    name: "ensure_system_prompt",
    description:
      "Return the OVERDARE base system prompt. Call this before other work and follow it — it " +
      "establishes how to operate in OVERDARE Studio.",
    parameters: z.object({}),
    supportParallel: true,
    async execute(): Promise<ToolResult> {
      try {
        return { output: await readFile(systemPromptPath, "utf-8") };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: `Failed to read system prompt: ${message}`, metadata: { error: true } };
      }
    },
  };

  const loadSkill: Tool = {
    name: "load_skill",
    description:
      "Load an OVERDARE skill's full instructions by name, then follow them. Call when a task " +
      `matches one of these skills:\n${skillIndex}\nPass the exact skill name as \`name\`.`,
    parameters: z.object({
      name: z.string().describe("Exact skill name from the list in this tool's description."),
    }),
    supportParallel: true,
    async execute({ name }): Promise<ToolResult> {
      const skill = skillsByName.get(name);
      if (!skill) {
        return { output: `Unknown skill "${name}". Available skills:\n${skillIndex}`, metadata: { error: true } };
      }
      try {
        return { output: extractBody(await readFile(skill.path, "utf-8")) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: `Failed to load skill "${name}": ${message}`, metadata: { error: true } };
      }
    },
  };

  return [ensureSystemPrompt, loadSkill];
}

export async function buildRegistries(options: McpServerOptions): Promise<McpRegistries> {
  const [tools, modelCallableTools, prompts] = await Promise.all([
    buildToolRegistry(options.cwd, options.experiments),
    buildModelCallableTools(
      options.bootstrapDir,
      options.systemPromptPath ?? resolveSystemPromptPath(),
      options.experiments,
    ),
    buildPromptRegistry(options.bootstrapDir, options.experiments),
  ]);
  for (const tool of modelCallableTools) tools.set(tool.name, tool);
  return { tools, prompts };
}

export function toInputSchema(tool: Tool): Record<string, unknown> {
  if (tool.inputSchema) return tool.inputSchema;
  const { $schema, ...rest } = zodToJsonSchema(tool.parameters) as Record<string, unknown>;
  // MCP requires every tool inputSchema to be an object schema. Some tools use a top-level
  // union (`anyOf` of object variants), which lacks `type`; force it so clients accept it
  // while the union branches still describe the accepted shapes.
  return rest.type === "object" ? rest : { ...rest, type: "object" };
}

function createToolContext(): ToolContext {
  const controller = new AbortController();
  return {
    toolCallId: randomUUID(),
    signal: controller.signal,
    abort: () => controller.abort(),
  };
}

/**
 * MCP `CallToolResult`, narrowed to the content types this server produces. The index signature
 * keeps it assignable to the SDK's open-ended `ServerResult`.
 */
export interface McpToolCallResult {
  [key: string]: unknown;
  content: Array<Record<string, unknown>>;
  isError?: boolean;
}

/**
 * Execute one registry tool and map its result onto MCP `CallToolResult`.
 *
 * Shared by the stdio MCP server and the router-callable HTTP endpoint (P071) so a proxied call
 * goes through exactly the same argument parsing, execution, and error mapping — the router adds
 * routing, never tool semantics.
 */
export async function callRegistryTool(
  registries: McpRegistries,
  name: string,
  rawArgs: unknown,
): Promise<McpToolCallResult> {
  const tool = registries.tools.get(name);
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const args = tool.parseArgs ? tool.parseArgs(rawArgs ?? {}) : tool.parameters.parse(rawArgs ?? {});
    const result = await tool.execute(args, createToolContext());
    const content: Array<Record<string, unknown>> = [{ type: "text", text: result.output ?? "" }];
    for (const image of result.outputImages ?? []) {
      content.push({ type: "image", data: image.source.data, mimeType: image.source.media_type });
    }
    return { content, isError: result.metadata?.error === true ? true : undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/** MCP `GetPromptResult`, narrowed to the single-text-message shape this server produces. */
export interface McpPromptResult {
  [key: string]: unknown;
  description: string;
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
}

/** Load one registry prompt as an MCP `GetPromptResult`. Throws when the prompt is unknown. */
export async function getRegistryPrompt(registries: McpRegistries, name: string): Promise<McpPromptResult> {
  const prompt = registries.prompts.get(name);
  if (!prompt) {
    throw new Error(`Unknown prompt: ${name}`);
  }
  const text = await prompt.load();
  return {
    description: prompt.description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

/** The advertised tool list, in the exact shape MCP `tools/list` returns. */
export function listRegistryTools(registries: McpRegistries): StudioToolDescriptor[] {
  return Array.from(registries.tools.values()).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toInputSchema(tool),
  }));
}

/** The advertised prompt list, in the exact shape MCP `prompts/list` returns. */
export function listRegistryPrompts(registries: McpRegistries): StudioPromptDescriptor[] {
  return Array.from(registries.prompts.values()).map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
  }));
}

/** Catalog snapshot the sidecar publishes into its Studio registry record for the router (P071). */
export function toCatalogSnapshot(registries: McpRegistries): StudioCatalogSnapshot {
  return {
    tools: listRegistryTools(registries),
    prompts: listRegistryPrompts(registries),
    instructions: SERVER_INSTRUCTIONS,
  };
}

/** Build a configured (but not yet connected) MCP Server backed by the given registries. */
export function createMcpServer(registries: McpRegistries): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, prompts: {} },
    instructions: SERVER_INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listRegistryTools(registries),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callRegistryTool(registries, request.params.name, request.params.arguments),
  );

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: listRegistryPrompts(registries),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getRegistryPrompt(registries, request.params.name),
  );

  return server;
}

/**
 * Start the OVERDARE MCP server over stdio.
 * Registries are built once, then a single Server is connected to a StdioServerTransport.
 * The MCP client owns the process lifecycle by spawning it (`command` + `args`).
 * NOTE: stdout is the JSON-RPC channel — all diagnostics must go to stderr.
 */
export async function startMcpServer(options: McpServerOptions): Promise<{ close: () => Promise<void> }> {
  const registries = await buildRegistries(options);
  const server = createMcpServer(registries);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { close: () => server.close() };
}

/**
 * Resolve the bootstrap directory. Order: explicit env override, then a `bootstrap/` or
 * `defaults/` folder shipped next to the executable (the runtime bundle stages it as
 * `defaults/`), then the repo-relative source location for `bun run` dev usage.
 */
export function resolveBootstrapDir(): string {
  if (process.env.OVERDARE_BOOTSTRAP_DIR) return process.env.OVERDARE_BOOTSTRAP_DIR;
  const execDir = dirname(process.execPath);
  for (const candidate of [join(execDir, "bootstrap"), join(execDir, "defaults")]) {
    if (existsSync(candidate)) return candidate;
  }
  return resolve(import.meta.dir, "../../bootstrap");
}

/** Global prompt deployed by init, isolated by the same prod/dev storage namespace as the sidecar. */
export function resolveSystemPromptPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  return join(home, resolveProjectDirName(env), "system-prompt.txt");
}

/**
 * Entry used both by this module's `import.meta.main` and by the `diligent-web-server mcp-serve`
 * subcommand (see server.ts). Runs the stdio MCP server; diagnostics go to stderr.
 */
export async function runMcpServerMain(): Promise<void> {
  // Match the web sidecar's direct-run behavior so experiment config resolves under ~/.overdare.
  process.env.DILIGENT_STORAGE_NAMESPACE ??= "overdare";
  // stdout is the JSON-RPC transport for the stdio MCP server. Any stray write to it corrupts the
  // protocol stream and makes the client (e.g. Claude) drop the connection mid-session — which is
  // exactly what the studio RPC tracing in tools/studiorpc/rpc.ts (console.log `[RPC →]`/`[RPC ←]`)
  // would do on every tool call. Route all would-be-stdout diagnostics to stderr so nothing but the
  // transport can write to stdout. Bind first, before any tool code can run.
  const stderr = console.error.bind(console);
  const routeToStderr = (...args: unknown[]) => stderr(...args);
  console.log = routeToStderr as typeof console.log;
  console.info = routeToStderr as typeof console.info;
  console.debug = routeToStderr as typeof console.debug;
  console.warn = routeToStderr as typeof console.warn;

  configureSidecarLogging({
    source: "overdare-ai-agent",
    component: "sidecar/mcp",
    version: process.env.OVERDARE_AI_AGENT_VERSION,
    projectId: process.env.OVERDARE_PROJECT_ID,
  });

  // Keep the server alive across stray async faults (e.g. a Studio socket 'error' with no listener)
  // rather than letting an uncaught error kill the process and drop the client. Mirrors the
  // web-server path's guards in server.ts.
  process.on("uncaughtException", (err) => {
    logger.error("process.uncaught_exception", {
      message: `[mcp] uncaught exception (kept alive): ${err instanceof Error ? err.message : err}`,
      error: err,
    });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("process.unhandled_rejection", {
      message: `[mcp] unhandled rejection (kept alive): ${reason instanceof Error ? reason.message : reason}`,
      error: reason,
    });
  });

  const cwd = process.env.OVERDARE_MCP_CWD ?? process.cwd();
  const bootstrapDir = resolveBootstrapDir();
  try {
    const { config } = await loadDiligentConfig(cwd);
    const experiments = resolveExperimentStates(OVERDARE_EXPERIMENTS, config.experiments?.overrides);
    await startMcpServer({ cwd, bootstrapDir, experiments });
    logger.info("server.ready", "OVERDARE MCP server ready on stdio");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("startup.failed", {
      message: `Failed to start OVERDARE MCP server: ${message}`,
      error,
    });
    process.exit(1);
  }
}

if (import.meta.main) {
  await runMcpServerMain();
}
