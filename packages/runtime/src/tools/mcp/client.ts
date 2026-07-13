// @summary MCP capability manager — tool listing, status tracking, resources, prompts, call execution

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpAuthRefresh, McpTransportFactory } from "./connection-pool";
import { McpConnectionPool } from "./connection-pool";
import type { McpOAuthDeps } from "./oauth";
import { isNeedsAuth } from "./oauth";
import {
  isHttpServer,
  isStdioServer,
  type McpCallResult,
  type McpGetPromptResult,
  type McpPromptDef,
  type McpReadResourceResult,
  type McpResourceDef,
  type McpServerConfig,
  type McpServerRuntime,
  type McpServerStatus,
  type McpTransportKind,
} from "./types";

// Re-exported so callers that import from this module continue to work unchanged.
export type { McpAuthRefresh, McpTransportFactory } from "./connection-pool";

/** Cached per-server outcome from the last `sync()`/`login()`, powering `listStatus` without reconnecting. */
interface CachedStatus {
  transport: McpTransportKind;
  status: McpServerStatus["status"];
  toolCount: number;
  error?: string;
}

function transportKind(config: McpServerConfig): McpTransportKind {
  if (isStdioServer(config)) return "stdio";
  if (isHttpServer(config)) return config.type === "sse" ? "sse" : "http";
  return "http";
}

function normalizeCallResult(result: Awaited<ReturnType<Client["callTool"]>>): McpCallResult {
  const textParts: string[] = [];
  const images: { data: string; mimeType: string }[] = [];
  const content = Array.isArray(result.content) ? result.content : [];

  for (const part of content) {
    if (part.type === "text") {
      textParts.push(part.text);
    } else if (part.type === "image") {
      images.push({ data: part.data, mimeType: part.mimeType });
    } else if (part.type === "audio") {
      textParts.push(`[audio ${part.mimeType} omitted]`);
    } else if (part.type === "resource") {
      const resource = part.resource as { text?: string; uri?: string };
      if (typeof resource.text === "string") textParts.push(resource.text);
      else if (typeof resource.uri === "string") textParts.push(`[resource ${resource.uri}]`);
    }
  }

  if (result.structuredContent && Object.keys(result.structuredContent).length > 0) {
    textParts.push(`Structured output:\n${JSON.stringify(result.structuredContent, null, 2)}`);
  }

  return { text: textParts.join("\n").trim(), images, isError: result.isError === true };
}

/**
 * Orchestrates MCP tool listing, status tracking, resources, prompts, and call execution.
 * Delegates all connection lifecycle (connect/disconnect/reconnect/OAuth state) to `McpConnectionPool`.
 */
export class McpConnectionManager {
  private pool: McpConnectionPool;
  /** Last-known per-server status, so `listStatus` reports without forcing a reconnect. */
  private lastStatus = new Map<string, CachedStatus>();

  constructor(transportFactory?: McpTransportFactory, authRefresh?: McpAuthRefresh) {
    this.pool = new McpConnectionPool(transportFactory, authRefresh);
  }

  /** Wire interactive-OAuth dependencies (browser opener + token store dir). Optional. */
  setOAuthDeps(deps: McpOAuthDeps | undefined): void {
    this.pool.setOAuthDeps(deps);
  }

  /** True once OAuth dependencies have been wired (so connect can attach/refresh tokens). */
  hasOAuthDeps(): boolean {
    return this.pool.hasOAuthDeps();
  }

  /**
   * Reconcile active connections against desired (already enable-filtered) config.
   * Connects new/changed servers in parallel with per-server isolation; disposes removed
   * or transport-changed connections. Never throws — failures surface as `status:"error"`.
   */
  async sync(servers: Record<string, McpServerConfig>): Promise<McpServerRuntime[]> {
    const desired = new Map(Object.entries(servers));

    // Dispose stale connections; remove lastStatus for servers that are gone entirely.
    const removed = await this.pool.disposeStale(desired);
    for (const name of removed) this.lastStatus.delete(name);

    return Promise.all(
      [...desired.entries()].map(async ([name, config]): Promise<McpServerRuntime> => {
        try {
          const conn = await this.pool.connectIfNeeded(name, config);
          this.recordStatus(name, config, { status: "connected", toolCount: conn.tools.length });
          return { name, status: "connected", tools: conn.tools };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // An OAuth server with missing/expired tokens surfaces `needs_auth` (never a browser);
          // interactive login is the separate `/mcp login` command.
          const status = isNeedsAuth(error) ? "needs_auth" : "error";
          this.recordStatus(name, config, { status, toolCount: 0, error: message });
          return { name, status, tools: [], error: message };
        }
      }),
    );
  }

  /**
   * Report per-server status for the `/mcp list` surface. Reads cached `sync()` state and only
   * triggers a `sync` when a configured server has never been reconciled — it never reconnects
   * an already-connected server. `enabled: false` servers report `disabled` without connecting.
   */
  async listStatus(servers: Record<string, McpServerConfig>): Promise<McpServerStatus[]> {
    const entries = Object.entries(servers);
    const enabled = Object.fromEntries(entries.filter(([, config]) => config.enabled !== false));
    const needsSync = Object.keys(enabled).some((name) => !this.lastStatus.has(name));
    if (needsSync) await this.sync(enabled);

    return entries.map(([name, config]): McpServerStatus => {
      const transport = transportKind(config);
      if (config.enabled === false) return { name, transport, status: "disabled", toolCount: 0 };
      const cached = this.lastStatus.get(name);
      return {
        name,
        transport,
        status: cached?.status ?? "error",
        toolCount: cached?.toolCount ?? 0,
        error: cached?.error,
      };
    });
  }

  /**
   * Interactive OAuth login for an HTTP server: opens the browser, awaits the loopback callback,
   * stores tokens, then reconnects and lists tools. `onAuthUrl` fires as soon as the authorization
   * URL is known. Resolves with the connected tool count; rejects on timeout/failure.
   */
  async login(
    serverName: string,
    config: McpServerConfig,
    options: { openBrowser?: (url: string) => void; onAuthUrl?: (url: string) => void } = {},
  ): Promise<{ toolCount: number }> {
    if (!isHttpServer(config)) {
      throw new Error(`MCP server "${serverName}" is stdio; OAuth login applies only to HTTP servers`);
    }
    if (!this.pool.hasOAuthDeps()) throw new Error("MCP OAuth is not configured (no store/browser dependencies)");
    try {
      const conn = await this.pool.loginOAuth(serverName, config, options);
      this.recordStatus(serverName, config, { status: "connected", toolCount: conn.tools.length });
      return { toolCount: conn.tools.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordStatus(serverName, config, { status: "needs_auth", toolCount: 0, error: message });
      throw error;
    }
  }

  /** Clear a server's stored OAuth credentials and drop its live connection. */
  async logout(serverName: string, config?: McpServerConfig): Promise<void> {
    await this.pool.logoutOAuth(serverName);
    if (config) this.recordStatus(serverName, config, { status: "needs_auth", toolCount: 0 });
    else this.lastStatus.delete(serverName);
  }

  private recordStatus(name: string, config: McpServerConfig, partial: Omit<CachedStatus, "transport">): void {
    this.lastStatus.set(name, { transport: transportKind(config), ...partial });
  }

  /** Call a tool on a connected server. Throws only if the server is not connected. */
  async call(serverName: string, toolName: string, args: unknown, signal: AbortSignal): Promise<McpCallResult> {
    const conn = this.pool.getConnection(serverName);
    if (!conn) throw new Error(`MCP server "${serverName}" is not connected`);
    const result = await conn.client.callTool(
      { name: toolName, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      { signal, timeout: conn.toolTimeoutMs },
    );
    return normalizeCallResult(result);
  }

  /** True when a connected server advertises the `resources` capability. */
  supportsResources(serverName: string): boolean {
    return this.pool.getConnection(serverName)?.capabilities?.resources != null;
  }

  /** True when a connected server advertises the `prompts` capability. */
  supportsPrompts(serverName: string): boolean {
    return this.pool.getConnection(serverName)?.capabilities?.prompts != null;
  }

  /** List a server's resources. Returns `[]` when not connected or the capability is absent. */
  async listResources(serverName: string): Promise<McpResourceDef[]> {
    const conn = this.pool.getConnection(serverName);
    if (!conn || conn.capabilities?.resources == null) return [];
    const listed = await conn.client.listResources(undefined, { timeout: conn.toolTimeoutMs });
    return listed.resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  /** Read a resource by URI. Throws only if the server is not connected. */
  async readResource(serverName: string, uri: string, signal: AbortSignal): Promise<McpReadResourceResult> {
    const conn = this.pool.getConnection(serverName);
    if (!conn) throw new Error(`MCP server "${serverName}" is not connected`);
    const res = await conn.client.readResource({ uri }, { signal, timeout: conn.toolTimeoutMs });
    const parts: string[] = [];
    for (const content of res.contents) {
      if ("text" in content && typeof content.text === "string") parts.push(content.text);
      else if ("blob" in content)
        parts.push(`[binary ${content.uri}${content.mimeType ? ` ${content.mimeType}` : ""}]`);
    }
    return { text: parts.join("\n").trim() };
  }

  /** List a server's prompt templates. Returns `[]` when not connected or the capability is absent. */
  async listPrompts(serverName: string): Promise<McpPromptDef[]> {
    const conn = this.pool.getConnection(serverName);
    if (!conn || conn.capabilities?.prompts == null) return [];
    const listed = await conn.client.listPrompts(undefined, { timeout: conn.toolTimeoutMs });
    return listed.prompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments?.map((a) => ({ name: a.name, description: a.description, required: a.required })),
    }));
  }

  /** Render a prompt template. Throws only if the server is not connected. */
  async getPrompt(
    serverName: string,
    name: string,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<McpGetPromptResult> {
    const conn = this.pool.getConnection(serverName);
    if (!conn) throw new Error(`MCP server "${serverName}" is not connected`);
    const stringArgs = args
      ? Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]))
      : undefined;
    const res = await conn.client.getPrompt({ name, arguments: stringArgs }, { signal, timeout: conn.toolTimeoutMs });
    const lines: string[] = [];
    for (const message of res.messages) {
      const content = message.content;
      if (content.type === "text") lines.push(`${message.role}: ${content.text}`);
      else if (content.type === "image") lines.push(`${message.role}: [image ${content.mimeType}]`);
      else if (content.type === "resource") {
        const resource = content.resource as { text?: string; uri?: string };
        lines.push(`${message.role}: ${resource.text ?? `[resource ${resource.uri}]`}`);
      } else lines.push(`${message.role}: [${(content as { type: string }).type}]`);
    }
    return { description: res.description as string | undefined, text: lines.join("\n").trim() };
  }

  async disposeAll(): Promise<void> {
    await this.pool.disposeAll();
  }
}

let singleton: McpConnectionManager | undefined;

/** Process-wide singleton so connections persist across turns. */
export function getMcpManager(): McpConnectionManager {
  singleton ??= new McpConnectionManager();
  return singleton;
}

/** Test-only reset of the process singleton. */
export function __resetMcpManagerForTest(): void {
  singleton = undefined;
}

/** Test-only injection of the process singleton. */
export function __setMcpManagerForTest(manager: McpConnectionManager | undefined): void {
  singleton = manager;
}
