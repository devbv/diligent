// @summary Internal runtime types for the MCP client (connection manager + tool bridge)

import type {
  McpGlobalConfig,
  McpHttpServerConfig,
  McpOAuthConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from "../../config/schema";

export type { McpGlobalConfig, McpHttpServerConfig, McpOAuthConfig, McpServerConfig, McpStdioServerConfig };

/** Default budget for connect + initial listTools (C1). */
export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000;
/** Default budget for a single tool call (C1). A hung call aborts instead of stalling the turn. */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 120_000;

/** How MCP tools are surfaced to the model. See `McpGlobalConfigSchema`. */
export type McpToolLoading = NonNullable<McpGlobalConfig["toolLoading"]>;

/**
 * In `auto` mode, switch from eager per-tool exposure to lazy search proxies once the number of
 * exposed MCP tools exceeds this count. Small setups stay eager (behavior unchanged); large
 * multi-server setups avoid paying full-schema context cost every turn.
 */
export const DEFAULT_MCP_LAZY_THRESHOLD = 20;

/** Default cap on a single MCP tool's output, in approx tokens (matches Claude Code's default). */
export const DEFAULT_MCP_MAX_OUTPUT_TOKENS = 25_000;
/** Default warn threshold for a single MCP tool's output, in approx tokens. */
export const DEFAULT_MCP_WARN_OUTPUT_TOKENS = 10_000;
/** Coarse token→byte factor used to turn the token-based caps into byte budgets for truncation. */
export const MCP_BYTES_PER_TOKEN = 4;

/** Resolved byte budgets for a single MCP tool call's output. */
export interface McpOutputLimit {
  /** Executor truncates output above this many bytes. */
  maxBytes: number;
  /** Console-warn when output exceeds this many bytes (never mutates the output). */
  warnBytes: number;
}

/**
 * One connected server tool, flattened for the lazy search/run proxy. Built after `sync()` from
 * each connected server's advertised tools with per-tool toggles already applied.
 */
export interface McpCatalogEntry {
  /** Config key (server name). */
  server: string;
  /** Raw server-side tool name (not namespaced). */
  tool: string;
  description?: string;
  /** JSON Schema advertised by the server, returned by `mcp_search_tools` on demand. */
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  /** Per-tool output cap in characters (from `_meta` `anthropic/maxResultSizeChars`). */
  maxResultSizeChars?: number;
}

/** A single tool advertised by a connected MCP server. */
export interface McpToolDef {
  /** Raw server-side tool name (not namespaced). */
  name: string;
  description?: string;
  /** JSON Schema advertised verbatim to the LLM via `Tool.inputSchema`. */
  inputSchema: Record<string, unknown>;
  /** From `annotations.readOnlyHint` — enables parallel execution (C6). */
  readOnly?: boolean;
  /** Per-tool output cap in characters, from the MCP `_meta` key `anthropic/maxResultSizeChars`. */
  maxResultSizeChars?: number;
}

/** A resource advertised by a connected MCP server (`resources/list`). */
export interface McpResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** One argument of an MCP prompt template. */
export interface McpPromptArgDef {
  name: string;
  description?: string;
  required?: boolean;
}

/** A prompt template advertised by a connected MCP server (`prompts/list`). */
export interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: McpPromptArgDef[];
}

/** Normalized result of reading a resource (`resources/read`). */
export interface McpReadResourceResult {
  /** Flattened text of all `text` content parts; blob parts noted as `[binary <uri>]`. */
  text: string;
}

/** Normalized result of getting a prompt (`prompts/get`). */
export interface McpGetPromptResult {
  description?: string;
  /** Rendered messages flattened to text lines like `user: ...` / `assistant: ...`. */
  text: string;
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
