// @summary MCP bundled tool provider — syncs connections and exposes enabled server tools

import type { Tool } from "@diligent/core/tool/types";
import type { BundledToolProvider } from "../bundled-provider";
import { getMcpManager } from "./client";
import { mcpToolToDiligentTool } from "./to-tool";
import type { McpServerConfig } from "./types";

/** Drop servers explicitly disabled via `enabled: false`. */
export function filterEnabledServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const enabled: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (config.enabled !== false) enabled[name] = config;
  }
  return enabled;
}

/**
 * Build a bundled provider that connects declared MCP servers (via the process-singleton
 * manager) and surfaces each connected server's enabled tools as namespaced Diligent tools.
 * Per-server/per-tool enablement is applied here so the catalog needs no toggle changes.
 */
export function createMcpToolProvider(servers: Record<string, McpServerConfig>): BundledToolProvider {
  return {
    id: "mcp",
    displayName: "MCP Servers",
    async createTools({ host }) {
      const manager = getMcpManager();
      const enabled = filterEnabledServers(servers);
      const runtimes = await manager.sync(enabled);
      const tools: Tool[] = [];

      for (const runtime of runtimes) {
        if (runtime.status !== "connected") {
          if (runtime.status === "error") {
            console.warn(`[mcp] server "${runtime.name}" unavailable: ${runtime.error}`);
          } else if (runtime.status === "needs_auth") {
            console.warn(`[mcp] server "${runtime.name}" needs authorization — run \`/mcp login ${runtime.name}\``);
          }
          continue;
        }
        const toolToggles = enabled[runtime.name]?.tools ?? {};
        for (const def of runtime.tools) {
          if (toolToggles[def.name] === false) continue;
          tools.push(mcpToolToDiligentTool({ serverName: runtime.name, def, manager, host }));
        }
      }

      return tools;
    },
  };
}
