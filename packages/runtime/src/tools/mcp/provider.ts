// @summary MCP bundled tool provider — syncs connections and exposes enabled server tools

import type { Tool } from "@diligent/core/tool/types";
import { createLogger } from "@diligent/logging";
import type { BundledToolProvider } from "../bundled-provider";
import { getMcpManager } from "./client";
import { createMcpPromptTools, createMcpResourceTools } from "./resources-prompts";
import { mcpToolToDiligentTool, resolveMcpOutputLimit } from "./to-tool";
import { createMcpRunTool, createMcpSearchTool } from "./tool-search";
import {
  DEFAULT_MCP_LAZY_THRESHOLD,
  DEFAULT_MCP_MAX_OUTPUT_TOKENS,
  DEFAULT_MCP_WARN_OUTPUT_TOKENS,
  MCP_BYTES_PER_TOKEN,
  type McpCatalogEntry,
  type McpOutputLimit,
  type McpServerConfig,
  type McpToolLoading,
} from "./types";

const logger = createLogger({ scope: "runtime.mcp.provider" });

/** Drop servers explicitly disabled via `enabled: false`. */
export function filterEnabledServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const enabled: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (config.enabled !== false) enabled[name] = config;
  }
  return enabled;
}

/** Options controlling how a server's tools are surfaced to the model. */
export interface McpToolProviderOptions {
  /** `eager` (default) exposes every tool; `lazy` exposes search+run proxies; `auto` picks by count. */
  toolLoading?: McpToolLoading;
  /** Threshold for `auto` mode (switch to lazy once exposed tool count exceeds this). */
  lazyThreshold?: number;
  /** Default per-tool output cap in approx tokens (a tool may raise it via `maxResultSizeChars`). */
  maxOutputTokens?: number;
  /** Console-warn threshold for a single tool's output, in approx tokens. */
  warnOutputTokens?: number;
  /** Expose resource proxy tools for servers that support them (default true). */
  exposeResources?: boolean;
  /** Expose prompt proxy tools for servers that support them (default true). */
  exposePrompts?: boolean;
}

/** Resolve `auto` into a concrete strategy based on how many tools would be exposed. */
function resolveLoading(mode: McpToolLoading | undefined, toolCount: number, threshold: number): "eager" | "lazy" {
  if (mode === "eager" || mode === "lazy") return mode;
  return toolCount > threshold ? "lazy" : "eager";
}

/**
 * Build a bundled provider that connects declared MCP servers (via the process-singleton
 * manager) and surfaces each connected server's enabled tools. Per-server/per-tool enablement is
 * applied here so the catalog needs no toggle changes.
 *
 * In `eager` mode each enabled tool becomes a namespaced Diligent tool (`mcp__server__tool`). In
 * `lazy` mode only two proxy tools are exposed (`mcp_search_tools` + `mcp_run_tool`) so full tool
 * schemas load on demand — keeping per-turn context cost roughly flat as servers/tools grow.
 */
export function createMcpToolProvider(
  servers: Record<string, McpServerConfig>,
  options: McpToolProviderOptions = {},
): BundledToolProvider {
  const threshold = options.lazyThreshold ?? DEFAULT_MCP_LAZY_THRESHOLD;
  const defaultLimit: McpOutputLimit = {
    maxBytes: (options.maxOutputTokens ?? DEFAULT_MCP_MAX_OUTPUT_TOKENS) * MCP_BYTES_PER_TOKEN,
    warnBytes: (options.warnOutputTokens ?? DEFAULT_MCP_WARN_OUTPUT_TOKENS) * MCP_BYTES_PER_TOKEN,
  };
  return {
    id: "mcp",
    displayName: "MCP Servers",
    async createTools({ host }) {
      const manager = getMcpManager();
      const enabled = filterEnabledServers(servers);
      const runtimes = await manager.sync(enabled);
      const catalog: McpCatalogEntry[] = [];
      const connectedServers: string[] = [];

      for (const runtime of runtimes) {
        if (runtime.status !== "connected") {
          if (runtime.status === "error") {
            logger.warn("server_unavailable", {
              message: `[mcp] server "${runtime.name}" unavailable: ${runtime.error}`,
              fields: { server: runtime.name, status: runtime.status, reason: runtime.error },
            });
          } else if (runtime.status === "needs_auth") {
            logger.warn("server_needs_auth", {
              message: `[mcp] server "${runtime.name}" needs authorization — run \`/mcp login ${runtime.name}\``,
              fields: { server: runtime.name, status: runtime.status },
            });
          }
          continue;
        }
        connectedServers.push(runtime.name);
        const toolToggles = enabled[runtime.name]?.tools ?? {};
        for (const def of runtime.tools) {
          if (toolToggles[def.name] === false) continue;
          catalog.push({
            server: runtime.name,
            tool: def.name,
            description: def.description,
            inputSchema: def.inputSchema,
            readOnly: def.readOnly,
            maxResultSizeChars: def.maxResultSizeChars,
          });
        }
      }

      // Resource/prompt proxy tools are added only for servers that advertise the capability.
      const extras: Tool[] = [];
      if (options.exposeResources !== false) {
        const resourceServers = connectedServers.filter((name) => manager.supportsResources(name));
        if (resourceServers.length > 0) extras.push(...createMcpResourceTools(resourceServers, manager, host));
      }
      if (options.exposePrompts !== false) {
        const promptServers = connectedServers.filter((name) => manager.supportsPrompts(name));
        if (promptServers.length > 0) extras.push(...createMcpPromptTools(promptServers, manager, host));
      }

      if (catalog.length === 0) return extras;

      const loading = resolveLoading(options.toolLoading, catalog.length, threshold);
      const toolTools: Tool[] =
        loading === "lazy"
          ? [createMcpSearchTool(catalog), createMcpRunTool({ catalog, manager, host, outputLimit: defaultLimit })]
          : catalog.map((entry) =>
              mcpToolToDiligentTool({
                serverName: entry.server,
                def: {
                  name: entry.tool,
                  description: entry.description,
                  inputSchema: entry.inputSchema,
                  readOnly: entry.readOnly,
                  maxResultSizeChars: entry.maxResultSizeChars,
                },
                manager,
                host,
                outputLimit: resolveMcpOutputLimit(entry.maxResultSizeChars, defaultLimit),
              }),
            );

      return [...toolTools, ...extras];
    },
  };
}
