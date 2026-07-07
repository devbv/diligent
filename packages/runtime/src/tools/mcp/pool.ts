// @summary McpConnectionPool — connection lifecycle, OAuth state, and deduplication

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
  NeedsAuthError,
  resolveAuthHeaders,
  shouldUseOAuth,
} from "./oauth";
import {
  DEFAULT_MCP_STARTUP_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  isHttpServer,
  isStdioServer,
  type McpServerConfig,
  type McpToolDef,
  type McpTransportKind,
} from "./types";

/** A live, fully-connected MCP server with its tools and capabilities cached from initialization. */
export interface ActiveConnection {
  signature: string;
  client: Client;
  transport: Transport;
  tools: McpToolDef[];
  toolTimeoutMs: number;
  /** Advertised server capabilities (from `initialize`), gating resources/prompts access. */
  capabilities: ReturnType<Client["getServerCapabilities"]>;
}

/** Builds the transport for a server. Injectable so tests can supply in-memory transports. */
export type McpTransportFactory = (
  name: string,
  config: McpServerConfig,
  authProvider: OAuthClientProvider | undefined,
) => Promise<Transport> | Transport;

/** Silent OAuth refresh entrypoint (SDK `auth`). Injectable so tests can drive the refresh path. */
export type McpAuthRefresh = (provider: OAuthClientProvider, options: { serverUrl: string | URL }) => Promise<string>;

/** Interactive OAuth login is allowed a longer budget than a plain connect. */
const OAUTH_LOGIN_TIMEOUT_MS = 180_000;

export function transportKind(config: McpServerConfig): McpTransportKind {
  if (isStdioServer(config)) return "stdio";
  if (isHttpServer(config)) return config.type === "sse" ? "sse" : "http";
  return "http";
}

/** Opt-in connect/refresh tracing (`DILIGENT_DEBUG_MCP=1`). */
export function mcpDiag(message: string): void {
  if (process.env.DILIGENT_DEBUG_MCP === "1") console.warn(`[mcp:diag] ${message}`);
}
function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Hash of config fields that affect the transport, excluding `enabled`/`tools` and timeouts. */
export function stableSignature(name: string, config: McpServerConfig): string {
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

/** Race a promise against a timeout, invoking `onTimeout` cleanup when it fires. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout: () => void,
): Promise<T> {
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

/**
 * True when a failure means the server needs interactive OAuth login — covers `NeedsAuthError`,
 * SDK `UnauthorizedError`/401, and RFC 6750/6749 token-rejection bodies (e.g. Atlassian returns
 * `{"error":"invalid_token"}` as a plain transport error instead of a 401).
 */
export function isNeedsAuth(error: unknown): boolean {
  if (error instanceof NeedsAuthError) return true;
  const name = (error as { name?: string })?.name;
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "UnauthorizedError" ||
    /unauthorized|\b401\b|\b403\b|invalid_token|invalid_grant|missing or invalid (access )?token|token (has )?expired/i.test(
      message,
    )
  );
}

/**
 * Owns raw MCP transport connections: connect, disconnect, reconnect, OAuth state, and
 * in-flight deduplication. Capability orchestration lives in `McpCapabilityManager`.
 */
export class McpConnectionPool {
  private connections = new Map<string, ActiveConnection>();
  /** In-flight connects keyed by `${name}\0${signature}` to coalesce concurrent syncs. */
  private pending = new Map<string, Promise<ActiveConnection>>();
  private oauthDeps: McpOAuthDeps | undefined;

  constructor(
    private readonly transportFactory?: McpTransportFactory,
    private readonly authRefresh: McpAuthRefresh = auth,
  ) {}

  /** Wire interactive-OAuth dependencies (browser opener + token store dir). Optional. */
  setOAuthDeps(deps: McpOAuthDeps | undefined): void {
    this.oauthDeps = deps;
  }
  /** True once OAuth deps are wired (so connect can attach/refresh tokens). */
  hasOAuthDeps(): boolean {
    return this.oauthDeps !== undefined;
  }
  /** Returns the current OAuth dependencies, if any. */
  getOAuthDeps(): McpOAuthDeps | undefined {
    return this.oauthDeps;
  }

  /** Returns the live connection for a server, or `undefined` if not connected. */
  getConnection(name: string): ActiveConnection | undefined {
    return this.connections.get(name);
  }
  /** Snapshot of all current connections, for reconciliation in `sync()`. */
  getConnectedEntries(): [string, ActiveConnection][] {
    return [...this.connections.entries()];
  }

  /** Coalesce concurrent connects to the same server+signature into one shared attempt. */
  connectDeduped(name: string, config: McpServerConfig): Promise<ActiveConnection> {
    const key = `${name}\u0000${stableSignature(name, config)}`;
    let inflight = this.pending.get(key);
    if (!inflight) {
      inflight = this.connect(name, config)
        .then((conn) => {
          this.connections.set(name, conn);
          return conn;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, inflight);
    }
    return inflight;
  }

  /**
   * Interactive OAuth login: opens the browser, awaits the loopback callback, stores tokens,
   * reconnects, and lists tools. The caller is responsible for updating the status cache.
   */
  async loginConnect(
    serverName: string,
    config: McpServerConfig,
    options: { openBrowser?: (url: string) => void; onAuthUrl?: (url: string) => void } = {},
  ): Promise<ActiveConnection> {
    if (!this.oauthDeps) throw new Error("MCP OAuth is not configured (no store/browser dependencies)");
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
      (config as { oauth?: unknown }).oauth as Parameters<typeof createMcpOAuthHandle>[2],
    );
    const client = new Client({ name: "diligent", version: DILIGENT_VERSION }, { capabilities: {} });
    try {
      let transport = await this.buildTransport(serverName, config, handle.provider);
      try {
        await withTimeout(client.connect(transport), startupTimeoutMs, `MCP "${serverName}" connect`, () => {
          void transport.close?.();
        });
      } catch (error) {
        if (!isNeedsAuth(error)) throw error;
        // Complete interactive login; then reconnect with a fresh transport (transports can't restart).
        const code = await handle.waitForCallback(OAUTH_LOGIN_TIMEOUT_MS);
        await (transport as StreamableHTTPClientTransport).finishAuth(code);
        transport = await this.buildTransport(serverName, config, handle.provider);
        await withTimeout(client.connect(transport), startupTimeoutMs, `MCP "${serverName}" reconnect`, () => {
          void transport.close?.();
        });
      }
      const listed = await withTimeout(client.listTools(), startupTimeoutMs, `MCP "${serverName}" listTools`, () => {
        void client.close();
      });
      const tools = mapToolDefs(listed.tools);
      const conn: ActiveConnection = {
        signature: stableSignature(serverName, config),
        client,
        transport,
        tools,
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

  /** Close and remove a connection. Best-effort — a dead server must not block. */
  async disposeConnection(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    this.connections.delete(name);
    try {
      await conn.client.close();
    } catch {
      // Best-effort: a server that already died must not block reconciliation.
    }
  }

  /** Clear a server's stored OAuth tokens from disk. Requires `oauthDeps` to be set. */
  async clearOAuthTokens(name: string): Promise<void> {
    if (this.oauthDeps) await clearStoredOAuth(this.oauthDeps.storeDir, name);
  }

  async disposeAll(): Promise<void> {
    for (const name of [...this.connections.keys()]) {
      await this.disposeConnection(name);
    }
  }

  private async connect(name: string, config: McpServerConfig): Promise<ActiveConnection> {
    // Connect-path OAuth: silent token load/refresh only. `NeedsAuthError` = user must `/mcp login`.
    let authProvider: OAuthClientProvider | undefined;
    if (isHttpServer(config) && this.oauthDeps && shouldUseOAuth(config)) {
      authProvider = createConnectOAuthProvider(name, this.oauthDeps, config.oauth);
    }

    try {
      return await this.openConnection(name, config, authProvider);
    } catch (error) {
      // Some servers reject expired tokens without a 401 (SDK refresh never fires). Force a silent
      // `auth()` refresh and reconnect once. `NeedsAuthError` from `auth()` → propagates as `needs_auth`.
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

  /** Single connect attempt with a fresh client: connect the transport, then list tools. */
  private async openConnection(
    name: string,
    config: McpServerConfig,
    authProvider: OAuthClientProvider | undefined,
  ): Promise<ActiveConnection> {
    const signature = stableSignature(name, config);
    const startupTimeoutMs = timeoutOf(config, "startupTimeoutMs", DEFAULT_MCP_STARTUP_TIMEOUT_MS);
    const toolTimeoutMs = timeoutOf(config, "toolTimeoutMs", DEFAULT_MCP_TOOL_TIMEOUT_MS);
    const client = new Client({ name: "diligent", version: DILIGENT_VERSION }, { capabilities: {} });
    const transport = await this.buildTransport(name, config, authProvider);
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

  private async buildTransport(
    name: string,
    config: McpServerConfig,
    authProvider: OAuthClientProvider | undefined,
  ): Promise<Transport> {
    if (this.transportFactory) {
      return this.transportFactory(name, config, authProvider);
    }
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
      if (config.type === "sse") {
        return new SSEClientTransport(new URL(config.url), { requestInit, authProvider });
      }
      return new StreamableHTTPClientTransport(new URL(config.url), { requestInit, authProvider });
    }
    throw new Error("MCP server config must specify either `command` (stdio) or `url` (http)");
  }
}
