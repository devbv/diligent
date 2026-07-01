// @summary Public surface of the MCP client module

export { getMcpManager, McpConnectionManager } from "./client";
export type { McpOAuthDeps, McpOAuthHandle } from "./oauth";
export { resolveAuthHeaders, shouldUseOAuth } from "./oauth";
export { createMcpToolProvider, filterEnabledServers } from "./provider";
export { mcpToolName, mcpToolToDiligentTool } from "./to-tool";
export type {
  McpCallResult,
  McpServerConfig,
  McpServerRuntime,
  McpToolDef,
} from "./types";
