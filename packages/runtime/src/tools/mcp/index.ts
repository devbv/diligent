// @summary Public surface of the MCP client module

export { getMcpManager, McpConnectionManager } from "./client";
export { buildMcpNeedsAuthNote } from "./needs-auth-note";
export type { McpOAuthDeps, McpOAuthHandle } from "./oauth";
export { resolveAuthHeaders, shouldUseOAuth } from "./oauth";
export { createMcpToolProvider, filterEnabledServers, type McpToolProviderOptions } from "./provider";
export { createMcpPromptTools, createMcpResourceTools } from "./resources-prompts";
export {
  callMcpToolWithApproval,
  mapMcpCallResult,
  mcpToolName,
  mcpToolToDiligentTool,
  resolveMcpOutputLimit,
} from "./to-tool";
export { createMcpRunTool, createMcpSearchTool } from "./tool-search";
export {
  DEFAULT_MCP_LAZY_THRESHOLD,
  DEFAULT_MCP_MAX_OUTPUT_TOKENS,
  DEFAULT_MCP_WARN_OUTPUT_TOKENS,
  MCP_BYTES_PER_TOKEN,
  type McpCallResult,
  type McpCatalogEntry,
  type McpGetPromptResult,
  type McpOutputLimit,
  type McpPromptDef,
  type McpReadResourceResult,
  type McpResourceDef,
  type McpServerConfig,
  type McpServerRuntime,
  type McpServerStatus,
  type McpToolDef,
  type McpToolLoading,
  type McpTransportKind,
} from "./types";
