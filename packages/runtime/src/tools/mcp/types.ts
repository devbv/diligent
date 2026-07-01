// @summary Internal runtime types for the MCP client (connection manager + tool bridge)

import type { McpHttpServerConfig, McpOAuthConfig, McpServerConfig, McpStdioServerConfig } from "../../config/schema";

export type { McpHttpServerConfig, McpOAuthConfig, McpServerConfig, McpStdioServerConfig };

/** Default budget for connect + initial listTools (C1). */
export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000;
/** Default budget for a single tool call (C1). A hung call aborts instead of stalling the turn. */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 120_000;

/** A single tool advertised by a connected MCP server. */
export interface McpToolDef {
  /** Raw server-side tool name (not namespaced). */
  name: string;
  description?: string;
  /** JSON Schema advertised verbatim to the LLM via `Tool.inputSchema`. */
  inputSchema: Record<string, unknown>;
  /** From `annotations.readOnlyHint` — enables parallel execution (C6). */
  readOnly?: boolean;
}

/** Reconciled state of a configured MCP server after `sync`. */
export interface McpServerRuntime {
  /** Config key (server name). */
  name: string;
  status: "connected" | "error" | "disabled";
  tools: McpToolDef[];
  error?: string;
}

/** Normalized result of a single MCP tool call. */
export interface McpCallResult {
  text: string;
  images: { data: string; mimeType: string }[];
  isError: boolean;
}

/** Type guard: config describes a stdio (local subprocess) server. */
export function isStdioServer(config: McpServerConfig): config is McpStdioServerConfig {
  return "command" in config && typeof config.command === "string";
}

/** Type guard: config describes an HTTP/SSE (remote) server. */
export function isHttpServer(config: McpServerConfig): config is McpHttpServerConfig {
  return "url" in config && typeof config.url === "string";
}
