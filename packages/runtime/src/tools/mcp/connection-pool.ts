// @summary MCP connection pool — signature-keyed connect/disconnect/reconnect lifecycle with OAuth state

import { createHash } from "node:crypto";
import { DILIGENT_VERSION } from "@diligent/protocol";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpOAuthDeps } from "./oauth";
import {
  clearStoredOAuth,
  createConnectOAuthProvider,
  createMcpOAuthHandle,
  isNeedsAuth,
  resolveAuthHeaders,
  shouldUseOAuth,
} from "./oauth";
import {
  DEFAULT_MCP_STARTUP_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  isHttpServer,
  isStdioServer,
  type McpHttpServerConfig,
  type McpServerConfig,
  type McpToolDef,
} from "./types";

/** Live MCP connection: raw SDK client, transport, and capability snapshot. */
export interface ActiveConnection {
  signature: string;
  client: Client;
  transport: Transport;
  tools: McpToolDef[];
  toolTimeoutMs: number;
  /** Advertised server capabilities (from `initialize`), gating resources/prompts access. */
  capabilities: ReturnType<Client["getServerCapabilities"]>;
}

const OAUTH_LOGIN_TIMEOUT_MS = 180_000;

/**
 * Builds the transport for a server. Injectable so tests can supply an in-memory
 * transport pair linked to a real MCP server without spawning processes or sockets.
 */
export type McpTransportFactory = (
  name: string,
  config: McpServerConfig,
  authProvider: OAuthClientProvider | undefined,
) => Promise<Transport> | Transport;

/** Silent OAuth refresh entrypoint (SDK `auth`). Injectable so tests can drive the refresh path. */
export type McpAuthRefresh = (provider: OAuthClientProvider, options: { serverUrl: string | URL }) => Promise<string>;

function stableSignature(name: string, config: McpServerConfig): string {
  // Excludes `enabled`/`tools` (applied downstream as filters) and timeouts (runtime-only).
  const relevant = isStdioServer(config)
    ? {
        kind: "stdio",
        command: config.command,
        args: config.args ?? [],
        env: config.env ?? {},
        cwd: config.cwd ?? null,
      }
    : isHttpServer(config)
      ? {
          kind: "http",
          type: config.type ?? "http",
          url: config.url,
          headers: config.headers ?? {},
          bearerTokenEnvVar: config.bearerTokenEnvVar ?? null,
          oauth: config.oauth ?? null,
        }
      : { kind: "unknown" };
  return createHash("sha256").update(JSON.stringify({ name, relevant })).digest("hex");
}

function timeoutOf(config: McpServerConfig, key: "startupTimeoutMs" | "toolTimeoutMs", fallback: number): number {
  const value = config[key];
  return typeof value === "number" && value > 0 ? value : fallback;
}

function readMaxResultSizeChars(tool: { _meta?: Record<string, unknown> }): number | undefined {
  const raw = tool._meta?.["anthropic/maxResultSizeChars"];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function mapToolDefs(tools: Awaited<ReturnType<Client["listTools"]>>["tools"]): McpToolDef[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
    readOnly: tool.annotations?.readOnlyHint === true,
    maxResultSizeChars: readMaxResultSizeChars(tool),
  }));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mcpDiag(message: string): void {
  if (process.env.DILIGENT_DEBUG_MCP === "1") console.warn(`[mcp:diag] ${message}`);
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Manages raw MCP connections: connect/disconnect/reconnect lifecycle, in-flight deduplication,
 * and OAuth state. Capability-level orchestration (status tracking, tool/resource/prompt routing)
 * lives in `McpConnectionManager`, which delegates connection management here.
 */
export class McpConnectionPool {
  private connections = new Map<string, ActiveConnection>();
  /** In-flight connects keyed by `${name}\0${signature}` — concurrent syncs share one attempt. */
  private pending = new Map<string, Promise<ActiveConnection>>();
  private oauthDeps: McpOAuthDeps | undefined;

  constructor(
    private readonly transportFactory?: McpTransportFactory,
    private readonly authRefresh: McpAuthRefresh = auth,
  ) {}

  setOAuthDeps(deps: McpOAuthDeps | undefined): void {
    this.oauthDeps = deps;
  }

  hasOAuthDeps(): boolean {
    return this.oauthDeps !== undefined;
  }

  getConnection(name: string): ActiveConnection | undefined {
    return this.connections.get(name);
  }

  /**
   * Dispose connections that are removed from `desired` or whose transport signature changed.
   * Returns server names that were fully removed so the caller can clean up associated metadata.
   */
  async disposeStale(desired: Map<string, McpServerConfig>): Promise<Set<string>> {
    const removed = new Set<string>();
    for (const [name, conn] of [...this.connections.entries()]) {
      const next = desired.get(name);
      if (!next) {
        await this.disposeConnection(name);
        removed.add(name);
      } else if (stableSignature(name, next) !== conn.signature) {
        await this.disposeConnection(name);
        // Still desired — will reconnect with new signature; not "removed".
      }
    }
    return removed;
  }

  /** Connect `name` if not already connected; coalesces concurrent attempts. */
  async connectIfNeeded(name: string, config: McpServerConfig): Promise<ActiveConnection> {
    const existing = this.connections.get(name);
    if (existing) return existing;
    const conn = await this.connectDeduped(name, config);
    this.connections.set(name, conn);
    return conn;
  }

  async disposeConnection(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    this.connections.delete(name);
    try {
      await conn.client.close();
    } catch {
      /* Best-effort: a dead server must not block. */
    }
  }

  async disposeAll(): Promise<void> {
    for (const name of [...this.connections.keys()]) await this.disposeConnection(name);
  }

  /**
   * Interactive OAuth login: open browser, await loopback callback, store tokens, reconnect,
   * list tools. `onAuthUrl` fires as soon as the URL is known (before the callback resolves).
   * Stores the resulting connection and returns it; throws on timeout/failure.
   */
  async loginOAuth(
    serverName: string,
    config: McpHttpServerConfig,
    options: { openBrowser?: (url: string) => void; onAuthUrl?: (url: string) => void } = {},
  ): Promise<ActiveConnection> {
    if (!this.oauthDeps) throw new Error("MCP OAuth is not configured (no store/browser dependencies)");
    await this.disposeConnection(serverName);
    const startupTimeoutMs = timeoutOf(config, "startupTimeoutMs", DEFAULT_MCP_STARTUP_TIMEOUT_MS);
    const toolTimeoutMs = timeoutOf(config, "toolTimeoutMs", DEFAULT_MCP_TOOL_TIMEOUT_MS);
    const opener = options.openBrowser ?? this.oauthDeps.openBrowser;
    const handle = createMcpOAuthHandle(
      serverName,
      {
        ...this.oauthDeps,
        openBrowser: (url) => {
          options.onAuthUrl?.(url);
          opener(url);
        },
      },
      config.oauth,
    );
    const client = new Client({ name: "diligent", version: DILIGENT_VERSION }, { capabilities: {} });
    try {
      let transport = await this.createTransport(serverName, config, handle.provider);
      try {
        await withTimeout(client.connect(transport), startupTimeoutMs, `MCP "${serverName}" connect`, () => {
          void transport.close?.();
        });
      } catch (error) {
        if (!isNeedsAuth(error)) throw error;
        // SDK opened browser via redirectToAuthorization; complete interactive login on the pending
        // transport, then reconnect with a fresh transport (SDK transports cannot start twice).
        const code = await handle.waitForCallback(OAUTH_LOGIN_TIMEOUT_MS);
        await (transport as StreamableHTTPClientTransport).finishAuth(code);
        transport = await this.createTransport(serverName, config, handle.provider);
        await withTimeout(client.connect(transport), startupTimeoutMs, `MCP "${serverName}" reconnect`, () => {
          void transport.close?.();
        });
      }
      const listed = await withTimeout(client.listTools(), startupTimeoutMs, `MCP "${serverName}" listTools`, () => {
        void client.close();
      });
      const conn: ActiveConnection = {
        signature: stableSignature(serverName, config),
        client,
        transport,
        tools: mapToolDefs(listed.tools),
        toolTimeoutMs,
        capabilities: client.getServerCapabilities(),
      };
      this.connections.set(serverName, conn);
      return conn;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    } finally {
      handle.close();
    }
  }

  /** Dispose the live connection and clear stored OAuth tokens for the server. */
  async logoutOAuth(serverName: string): Promise<void> {
    await this.disposeConnection(serverName);
    if (this.oauthDeps) await clearStoredOAuth(this.oauthDeps.storeDir, serverName);
  }

  private connectDeduped(name: string, config: McpServerConfig): Promise<ActiveConnection> {
    const key = `${name}\u0000${stableSignature(name, config)}`;
    let inflight = this.pending.get(key);
    if (!inflight) {
      inflight = this.connect(name, config).finally(() => this.pending.delete(key));
      this.pending.set(key, inflight);
    }
    return inflight;
  }

  private async connect(name: string, config: McpServerConfig): Promise<ActiveConnection> {
    // Connect-path OAuth: load stored tokens + silent refresh only. If the SDK would need
    // interactive authorization, the provider throws `NeedsAuthError` (no browser) so the
    // caller surfaces `needs_auth` instead of opening a browser mid-connect.
    let authProvider: OAuthClientProvider | undefined;
    if (isHttpServer(config) && this.oauthDeps && shouldUseOAuth(config)) {
      authProvider = createConnectOAuthProvider(name, this.oauthDeps, config.oauth);
    }
    try {
      return await this.openConnection(name, config, authProvider);
    } catch (error) {
      // Some servers (e.g. Atlassian) reject an expired access token with a non-401 body, so the
      // SDK's built-in refresh (gated on HTTP 401) never fires. Force a silent token refresh via
      // the SDK `auth()` and reconnect once. If interactive login is actually required, `auth()`
      // throws `NeedsAuthError` → propagates as `needs_auth`.
      mcpDiag(`"${name}" connect failed (authProvider=${authProvider ? "yes" : "no"}): ${errText(error)}`);
      if (!authProvider || !isHttpServer(config) || !isNeedsAuth(error)) throw error;
      const startupTimeoutMs = timeoutOf(config, "startupTimeoutMs", DEFAULT_MCP_STARTUP_TIMEOUT_MS);
      let result: string;
      try {
        result = await withTimeout(
          this.authRefresh(authProvider, { serverUrl: config.url }),
          startupTimeoutMs,
          `MCP "${name}" token refresh`,
          () => {},
        );
      } catch (refreshError) {
        mcpDiag(`"${name}" silent token refresh threw: ${errText(refreshError)}`);
        throw refreshError;
      }
      mcpDiag(`"${name}" silent token refresh result: ${result}`);
      if (result !== "AUTHORIZED") throw error;
      return await this.openConnection(name, config, authProvider);
    }
  }

  private async openConnection(
    name: string,
    config: McpServerConfig,
    authProvider: OAuthClientProvider | undefined,
  ): Promise<ActiveConnection> {
    const signature = stableSignature(name, config);
    const startupTimeoutMs = timeoutOf(config, "startupTimeoutMs", DEFAULT_MCP_STARTUP_TIMEOUT_MS);
    const toolTimeoutMs = timeoutOf(config, "toolTimeoutMs", DEFAULT_MCP_TOOL_TIMEOUT_MS);
    const client = new Client({ name: "diligent", version: DILIGENT_VERSION }, { capabilities: {} });
    const transport = await this.createTransport(name, config, authProvider);
    await withTimeout(client.connect(transport), startupTimeoutMs, `MCP "${name}" connect`, () => {
      void transport.close?.();
    });
    const listed = await withTimeout(client.listTools(), startupTimeoutMs, `MCP "${name}" listTools`, () => {
      void client.close();
    });
    return {
      signature,
      client,
      transport,
      tools: mapToolDefs(listed.tools),
      toolTimeoutMs,
      capabilities: client.getServerCapabilities(),
    };
  }

  private async createTransport(
    name: string,
    config: McpServerConfig,
    authProvider: OAuthClientProvider | undefined,
  ): Promise<Transport> {
    if (this.transportFactory) return this.transportFactory(name, config, authProvider);
    if (isStdioServer(config)) {
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      });
    }
    if (isHttpServer(config)) {
      const headers = resolveAuthHeaders(config);
      const requestInit: RequestInit = Object.keys(headers).length > 0 ? { headers } : {};
      if (config.type === "sse") return new SSEClientTransport(new URL(config.url), { requestInit, authProvider });
      return new StreamableHTTPClientTransport(new URL(config.url), { requestInit, authProvider });
    }
    throw new Error("MCP server config must specify either `command` (stdio) or `url` (http)");
  }
}
