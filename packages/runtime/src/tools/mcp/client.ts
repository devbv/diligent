// @summary McpCapabilityManager — capability orchestration (tool listing, status, calls) built on McpConnectionPool

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpOAuthDeps } from "./oauth";
import {
  isNeedsAuth,
  type McpAuthRefresh,
  McpConnectionPool,
  type McpTransportFactory,
  stableSignature,
  transportKind,
} from "./pool";
import {
  isHttpServer,
  type McpCallResult,
  type McpGetPromptResult,
  type McpPromptDef,
  type McpReadResourceResult,
  type McpResourceDef,
  type McpServerConfig,
  type McpServerRuntime,
  type McpServerStatus,
} from "./types";

export type { McpAuthRefresh, McpTransportFactory } from "./pool";

/** Cached per-server outcome from the last `sync()`/`login()`, powering `listStatus`. */
interface CachedStatus {
  transport: ReturnType<typeof transportKind>;
  status: McpServerStatus["status"];
  toolCount: number;
  error?: string;
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
 * Orchestrates MCP capability operations — tool listing, status tracking, resources, prompts, and
 * call execution — on top of `McpConnectionPool` which owns connection lifecycle and OAuth state.
 */
export class McpCapabilityManager {
  private readonly pool: McpConnectionPool;
  private lastStatus = new Map<string, CachedStatus>();

  constructor(transportFactory?: McpTransportFactory, authRefresh?: McpAuthRefresh) {
    this.pool = new McpConnectionPool(transportFactory, authRefresh);
  }

  /** Wire interactive-OAuth dependencies (browser opener + token store dir). Optional. */
  setOAuthDeps(deps: McpOAuthDeps | undefined): void {
    this.pool.setOAuthDeps(deps);
  }

  /** True once OAuth dependencies have been wired. */
  hasOAuthDeps(): boolean {
    return this.pool.hasOAuthDeps();
  }

  /**
   * Reconcile active connections against desired (already enable-filtered) config.
   * Connects new/changed servers in parallel; disposes removed or transport-changed connections.
   * Never throws — failures surface as `status:"error"`.
   */
  async sync(servers: Record<string, McpServerConfig>): Promise<McpServerRuntime[]> {
    const desired = new Map(Object.entries(servers));

    for (const [name, conn] of this.pool.getConnectedEntries()) {
      const next = desired.get(name);
      if (!next || stableSignature(name, next) !== conn.signature) {
        await this.pool.disposeConnection(name);
        if (!next) this.lastStatus.delete(name);
      }
    }

    const results = await Promise.all(
      [...desired.entries()].map(async ([name, config]): Promise<McpServerRuntime> => {
        const existing = this.pool.getConnection(name);
        if (existing) {
          this.recordStatus(name, config, { status: "connected", toolCount: existing.tools.length });
          return { name, status: "connected", tools: existing.tools };
        }
        try {
          const conn = await this.pool.connectDeduped(name, config);
          this.recordStatus(name, config, { status: "connected", toolCount: conn.tools.length });
          return { name, status: "connected", tools: conn.tools };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = isNeedsAuth(error) ? "needs_auth" : "error";
          this.recordStatus(name, config, { status, toolCount: 0, error: message });
          return { name, status, tools: [], error: message };
        }
      }),
    );

    return results;
  }

  /**
   * Report per-server status for the `/mcp list` surface. Reads cached `sync()` state and only
   * triggers a `sync` when a configured server has never been reconciled. `enabled: false` servers
   * report `disabled` without any connection attempt.
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
    await this.pool.disposeConnection(serverName);
    try {
      const conn = await this.pool.loginConnect(serverName, config, options);
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
    await this.pool.disposeConnection(serverName);
    await this.pool.clearOAuthTokens(serverName);
    if (config) this.recordStatus(serverName, config, { status: "needs_auth", toolCount: 0 });
    else this.lastStatus.delete(serverName);
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

  /** List a server's prompt templates. Returns `[]` when not connected or capability is absent. */
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

  private recordStatus(name: string, config: McpServerConfig, partial: Omit<CachedStatus, "transport">): void {
    this.lastStatus.set(name, { transport: transportKind(config), ...partial });
  }
}

/** `McpConnectionManager` is the public name for `McpCapabilityManager` — kept for backward compatibility. */
export { McpCapabilityManager as McpConnectionManager };

let singleton: McpCapabilityManager | undefined;

/** Process-wide singleton so connections persist across turns. */
export function getMcpManager(): McpCapabilityManager {
  singleton ??= new McpCapabilityManager();
  return singleton;
}

/** Test-only reset of the process singleton. */
export function __resetMcpManagerForTest(): void {
  singleton = undefined;
}

/** Test-only injection of the process singleton. */
export function __setMcpManagerForTest(manager: McpCapabilityManager | undefined): void {
  singleton = manager;
}
