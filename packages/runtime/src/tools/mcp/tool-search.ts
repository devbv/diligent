// @summary Lazy MCP exposure — a search tool + a run proxy so tool schemas load on demand

import type { Tool, ToolResult } from "@diligent/core/tool/types";
import { z } from "zod";
import type { RuntimeToolHost } from "../capabilities";
import type { McpConnectionManager } from "./client";
import { callMcpToolWithApproval, resolveMcpOutputLimit } from "./to-tool";
import type { McpCatalogEntry, McpOutputLimit } from "./types";

/** Max entries returned by a single `mcp_search_tools` call, so results never blow up context. */
const MAX_SEARCH_RESULTS = 25;

const searchParams = z.object({
  query: z.string().optional().describe("Keywords matched against tool names and descriptions."),
  server: z.string().optional().describe("Restrict results to a single MCP server by name."),
});

const runParams = z.object({
  server: z.string().describe("MCP server name (as shown by mcp_search_tools)."),
  tool: z.string().describe("Raw tool name on that server (as shown by mcp_search_tools)."),
  args: z.record(z.string(), z.unknown()).optional().describe("Arguments object for the tool."),
});

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Compact, mostly-flat index (server → tool names) so the model knows what exists without a call. */
function buildIndex(catalog: McpCatalogEntry[]): string {
  const byServer = new Map<string, McpCatalogEntry[]>();
  for (const entry of catalog) {
    const list = byServer.get(entry.server) ?? [];
    list.push(entry);
    byServer.set(entry.server, list);
  }
  const lines: string[] = [];
  for (const [server, entries] of byServer) {
    lines.push(`- ${server} (${entries.length}): ${entries.map((e) => e.tool).join(", ")}`);
  }
  return lines.join("\n");
}

function scoreEntry(entry: McpCatalogEntry, tokens: string[]): number {
  if (tokens.length === 0) return 1;
  const haystack = `${entry.server} ${entry.tool} ${entry.description ?? ""}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

/**
 * `mcp_search_tools` — discovery half of lazy loading. Returns matching tools with their full
 * input schemas so the model can then invoke them with `mcp_run_tool`. The tool description
 * carries a compact name index so the model always knows which servers/tools exist without a call.
 */
export function createMcpSearchTool(catalog: McpCatalogEntry[]): Tool {
  const index = buildIndex(catalog);
  const description = [
    "Search tools exposed by connected MCP servers and return their full input schemas.",
    "Use this to discover the exact arguments a tool takes, then invoke it with mcp_run_tool.",
    "Call with no arguments to list everything, a `query` to keyword-search, or a `server` to scope.",
    "",
    "Available MCP tools by server:",
    index || "(none)",
  ].join("\n");

  return {
    name: "mcp_search_tools",
    description,
    parameters: searchParams,
    supportParallel: true,
    async execute({ query, server }): Promise<ToolResult> {
      const tokens = (query ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter((t: string) => t.length > 0);
      let pool = catalog;
      if (server) pool = pool.filter((e) => e.server === server);

      const scored = pool
        .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score);

      const matched = scored.slice(0, MAX_SEARCH_RESULTS).map(({ entry }) => ({
        server: entry.server,
        tool: entry.tool,
        description: entry.description ? truncate(entry.description, 400) : undefined,
        inputSchema: entry.inputSchema,
      }));

      if (matched.length === 0) {
        const scope = server ? ` on server "${server}"` : "";
        return { output: `No MCP tools matched${scope}. Call mcp_search_tools with no query to list all tools.` };
      }

      const header =
        scored.length > matched.length
          ? `Showing ${matched.length} of ${scored.length} matches (refine your query to narrow).\n`
          : "";
      return { output: `${header}${JSON.stringify(matched, null, 2)}` };
    },
  };
}

/**
 * `mcp_run_tool` — execution half of lazy loading. Proxies a call to any advertised MCP tool by
 * `server`/`tool`, reusing the same approval + result mapping as the eager per-tool bridge.
 */
export function createMcpRunTool(args: {
  catalog: McpCatalogEntry[];
  manager: McpConnectionManager;
  host?: RuntimeToolHost;
  outputLimit: McpOutputLimit;
}): Tool {
  const { catalog, manager, host, outputLimit } = args;
  const byKey = new Map(catalog.map((e) => [`${e.server}\u0000${e.tool}`, e]));

  return {
    name: "mcp_run_tool",
    description:
      "Execute a tool on a connected MCP server. Discover the server, tool name and argument " +
      "schema first with mcp_search_tools, then pass the tool's arguments as `args`.",
    parameters: runParams,
    async execute({ server, tool, args: toolArgs }, ctx): Promise<ToolResult> {
      const entry = byKey.get(`${server}\u0000${tool}`);
      if (!entry) {
        return {
          output: `Unknown MCP tool "${tool}" on server "${server}". Use mcp_search_tools to find valid server/tool names.`,
          metadata: { error: true },
        };
      }
      return callMcpToolWithApproval({
        manager,
        host,
        serverName: server,
        toolName: tool,
        approvalToolName: "mcp_run_tool",
        rawArgs: toolArgs ?? {},
        ctx,
        outputLimit: resolveMcpOutputLimit(entry.maxResultSizeChars, outputLimit),
      });
    },
  };
}
