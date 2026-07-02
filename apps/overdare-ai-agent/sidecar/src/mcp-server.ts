// @summary OVERDARE MCP server runner: re-exposes studio built-in tools as MCP tools,
// and bootstrap skills + agents + the base system prompt as MCP prompts, over stdio.

import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Tool, ToolContext } from "@diligent/core/tool/types";
import type { BundledToolProvider } from "@diligent/runtime";
import { discoverSkills, extractBody, parseFrontmatter } from "@diligent/runtime/skills";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createRagToolProvider } from "./tools/rag";
import { createStudioRpcToolProvider } from "./tools/studiorpc";
import { createValidatorToolProvider } from "./tools/validator";

const SERVER_INFO = { name: "overdare-ai-agent", version: "0.0.1" } as const;

/** Server-level guidance surfaced to the client on `initialize`. */
const SERVER_INSTRUCTIONS =
  "This server exposes OVERDARE Studio tools and prompts. Before doing anything else, fetch the " +
  '"overdare-system-prompt" prompt (prompts/get) and follow it — it establishes how to work with ' +
  "OVERDARE. The other prompts are OVERDARE skills/agents you can pull in when relevant. " +
  "IMPORTANT: the agent's working directory (cwd) MUST be an OVERDARE Studio project folder that " +
  "contains a .uasset file; the studio tools resolve project paths against that cwd, so if it is " +
  "not such a folder, do not proceed — set the cwd correctly first.";

export interface McpServerOptions {
  /** Working directory tools resolve project paths against. */
  cwd: string;
  /** Directory containing bootstrap `skills/`, `agents/`, and `system-prompt.txt`. */
  bootstrapDir: string;
}

/** A prompt exposed over MCP (skill / agent / system prompt), loaded lazily. */
interface PromptEntry {
  name: string;
  description: string;
  load: () => Promise<string>;
}

interface McpRegistries {
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

async function buildToolRegistry(cwd: string): Promise<Map<string, Tool>> {
  const tools = new Map<string, Tool>();
  for (const provider of studioToolProviders()) {
    for (const tool of await provider.createTools({ cwd })) {
      tools.set(tool.name, tool);
    }
  }
  return tools;
}

async function buildPromptRegistry(bootstrapDir: string): Promise<Map<string, PromptEntry>> {
  const prompts = new Map<string, PromptEntry>();

  // Base system prompt.
  const systemPromptPath = join(bootstrapDir, "system-prompt.txt");
  prompts.set("overdare-system-prompt", {
    name: "overdare-system-prompt",
    description: "OVERDARE base system prompt.",
    load: () => readFile(systemPromptPath, "utf-8"),
  });

  // Bootstrap skills (each SKILL.md body becomes a prompt).
  const skillsDir = join(bootstrapDir, "skills");
  const { skills } = await discoverSkills({
    cwd: bootstrapDir,
    globalConfigDir: join(bootstrapDir, "__no_global__"),
    additionalPaths: [skillsDir],
  });
  for (const skill of skills) {
    const path = skill.path;
    prompts.set(skill.name, {
      name: skill.name,
      description: skill.description,
      load: async () => extractBody(await readFile(path, "utf-8")),
    });
  }

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
    const promptName = `agent-${parsed.frontmatter.name}`;
    prompts.set(promptName, {
      name: promptName,
      description: parsed.frontmatter.description,
      load: async () => extractBody(content),
    });
  }

  return prompts;
}

export async function buildRegistries(options: McpServerOptions): Promise<McpRegistries> {
  const [tools, prompts] = await Promise.all([
    buildToolRegistry(options.cwd),
    buildPromptRegistry(options.bootstrapDir),
  ]);
  return { tools, prompts };
}

function toInputSchema(tool: Tool): Record<string, unknown> {
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

/** Build a configured (but not yet connected) MCP Server backed by the given registries. */
export function createMcpServer(registries: McpRegistries): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, prompts: {} },
    instructions: SERVER_INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(registries.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toInputSchema(tool),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
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
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: Array.from(registries.prompts.values()).map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = registries.prompts.get(request.params.name);
    if (!prompt) {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    const text = await prompt.load();
    return {
      description: prompt.description,
      messages: [{ role: "user", content: { type: "text", text } }],
    };
  });

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
function resolveBootstrapDir(): string {
  if (process.env.OVERDARE_BOOTSTRAP_DIR) return process.env.OVERDARE_BOOTSTRAP_DIR;
  const execDir = dirname(process.execPath);
  for (const candidate of [join(execDir, "bootstrap"), join(execDir, "defaults")]) {
    if (existsSync(candidate)) return candidate;
  }
  return resolve(import.meta.dir, "../../bootstrap");
}

/**
 * Entry used both by this module's `import.meta.main` and by the `diligent-web-server mcp-serve`
 * subcommand (see server.ts). Runs the stdio MCP server; diagnostics go to stderr.
 */
export async function runMcpServerMain(): Promise<void> {
  const cwd = process.env.OVERDARE_MCP_CWD ?? process.cwd();
  const bootstrapDir = resolveBootstrapDir();
  try {
    await startMcpServer({ cwd, bootstrapDir });
    console.error("OVERDARE MCP server ready on stdio");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start OVERDARE MCP server: ${message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await runMcpServerMain();
}
