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
  /**
   * `needs_auth`: an OAuth server whose stored tokens are missing/expired and could not be
   * silently refreshed. `connect` never opens a browser (that is the M2 `/mcp login` command);
   * it surfaces this state so the UX can prompt for login.
   */
  status: "connected" | "error" | "disabled" | "needs_auth";
  tools: McpToolDef[];
  error?: string;
}

/** Transport family of a configured MCP server, surfaced in management UIs. */
export type McpTransportKind = "stdio" | "http" | "sse";

/**
 * User-facing status of a configured MCP server for the `/mcp list` surface (P070).
 * Derived from the last `sync()`/`login()` result — see `McpConnectionManager.listStatus`.
 */
export interface McpServerStatus {
  name: string;
  transport: McpTransportKind;
  status: "connected" | "needs_auth" | "error" | "disabled";
  toolCount: number;
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
