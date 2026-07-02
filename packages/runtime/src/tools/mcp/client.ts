// @summary MCP connection manager — signature-keyed connect/list/call with per-server isolation

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
  type McpCallResult,
  type McpGetPromptResult,
  type McpPromptDef,
  type McpReadResourceResult,
  type McpResourceDef,
  type McpServerConfig,
  type McpServerRuntime,
  type McpServerStatus,
  type McpToolDef,
  type McpTransportKind,
} from "./types";

interface ActiveConnection {
  signature: string;
  client: Client;
  transport: Transport;
  tools: McpToolDef[];
  toolTimeoutMs: number;
  /** Advertised server capabilities (from `initialize`), gating resources/prompts access. */
  capabilities: ReturnType<Client["getServerCapabilities"]>;
}

/** Cached per-server outcome from the last `sync()`/`login()`, powering `listStatus` without reconnecting. */
interface CachedStatus {
  transport: McpTransportKind;
  status: McpServerStatus["status"];
  toolCount: number;
  error?: string;
}

/** Interactive OAuth login is allowed a longer budget than a plain connect. */
const OAUTH_LOGIN_TIMEOUT_MS = 180_000;

function transportKind(config: McpServerConfig): McpTransportKind {
  if (isStdioServer(config)) return "stdio";
  if (isHttpServer(config)) return config.type === "sse" ? "sse" : "http";
  return "http";
}

/** Opt-in connect/refresh tracing (`DILIGENT_DEBUG_MCP=1`) for diagnosing OAuth token issues. */
function mcpDiag(message: string): void {
  if (process.env.DILIGENT_DEBUG_MCP === "1") console.warn(`[mcp:diag] ${message}`);
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/** Read the optional per-tool output cap advertised via MCP `_meta` (`anthropic/maxResultSizeChars`). */
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

/** Race a promise against a timeout, invoking `onTimeout` cleanup when it fires. */
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

export class McpConnectionManager {
  private connections = new Map<string, ActiveConnection>();
  /** In-flight connects keyed by `${name}\0${signature}`, so concurrent syncs (e.g. tools/list
   *  + the agent turn) share a single connection attempt and never trigger a second OAuth login. */
  private pending = new Map<string, Promise<ActiveConnection>>();
  /** Last-known per-server status, so `listStatus` reports without forcing a reconnect. */
  private lastStatus = new Map<string, CachedStatus>();
  private oauthDeps: McpOAuthDeps | undefined;

  constructor(
    private readonly transportFactory?: McpTransportFactory,
    private readonly authRefresh: McpAuthRefresh = auth,
  ) {}

  /** Wire interactive-OAuth dependencies (browser opener + token store dir). Optional. */
  setOAuthDeps(deps: McpOAuthDeps | undefined): void {
    this.oauthDeps = deps;
  }

  /** True once OAuth dependencies have been wired (so connect can attach/refresh tokens). */
  hasOAuthDeps(): boolean {
    return this.oauthDeps !== undefined;
  }

  /**
   * Reconcile active connections against desired (already enable-filtered) config.
   * Connects new/changed servers in parallel with per-server isolation; disposes removed
   * or transport-changed connections. Never throws — failures surface as `status:"error"`.
   */
  async sync(servers: Record<string, McpServerConfig>): Promise<McpServerRuntime[]> {
    const desired = new Map(Object.entries(servers));

    // Dispose connections that are gone or whose transport signature changed.
    for (const [name, conn] of [...this.connections.entries()]) {
      const next = desired.get(name);
      if (!next || stableSignature(name, next) !== conn.signature) {
        await this.disposeConnection(name);
        if (!next) this.lastStatus.delete(name);
      }
    }

    const results = await Promise.all(
      [...desired.entries()].map(async ([name, config]): Promise<McpServerRuntime> => {
        const existing = this.connections.get(name);
        if (existing) {
          this.recordStatus(name, config, { status: "connected", toolCount: existing.tools.length });
          return { name, status: "connected", tools: existing.tools };
        }
        try {
          const conn = await this.connectDeduped(name, config);
          this.connections.set(name, conn);
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

    return results;
  }

  /**
   * Report per-server status for the `/mcp list` surface. Reads cached `sync()` state and only
   * triggers a `sync` when a configured server has never been reconciled — it never reconnects
   * an already-connected server (C: avoid latency/churn). `enabled: false` servers report
   * `disabled` without any connection attempt.
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
   * Interactive OAuth login for an HTTP server: opens the browser (via `oauthDeps.openBrowser`),
   * awaits the loopback callback, stores tokens, then reconnects and lists tools. `onAuthUrl`
   * fires as soon as the authorization URL is known (before the callback), so the caller can
   * surface it. Resolves with the connected tool count; rejects on timeout/failure.
   */
  async login(
    serverName: string,
    config: McpServerConfig,
    options: { openBrowser?: (url: string) => void; onAuthUrl?: (url: string) => void } = {},
  ): Promise<{ toolCount: number }> {
    if (!isHttpServer(config)) {
      throw new Error(`MCP server "${serverName}" is stdio; OAuth login applies only to HTTP servers`);
    }
    if (!this.oauthDeps) throw new Error("MCP OAuth is not configured (no store/browser dependencies)");

    // Drop any stale connection so we reconnect fresh with the tokens obtained below.
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
        // The SDK opened the browser via redirectToAuthorization; complete the interactive login on
        // the pending transport, then reconnect with a fresh transport (an SDK transport cannot be
        // started twice) that picks up the tokens the provider just persisted.
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
      const tools = mapToolDefs(listed.tools);
      this.connections.set(serverName, {
        signature: stableSignature(serverName, config),
        client,
        transport,
        tools,
        toolTimeoutMs,
        capabilities: client.getServerCapabilities(),
      });
      this.recordStatus(serverName, config, { status: "connected", toolCount: tools.length });
      return { toolCount: tools.length };
    } catch (error) {
      await client.close().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      this.recordStatus(serverName, config, { status: "needs_auth", toolCount: 0, error: message });
      throw error;
    } finally {
      handle.close();
    }
  }

  /** Clear a server's stored OAuth credentials and drop its live connection. */
  async logout(serverName: string, config?: McpServerConfig): Promise<void> {
    await this.disposeConnection(serverName);
    if (this.oauthDeps) await clearStoredOAuth(this.oauthDeps.storeDir, serverName);
    if (config) this.recordStatus(serverName, config, { status: "needs_auth", toolCount: 0 });
    else this.lastStatus.delete(serverName);
  }

  private recordStatus(name: string, config: McpServerConfig, partial: Omit<CachedStatus, "transport">): void {
    this.lastStatus.set(name, { transport: transportKind(config), ...partial });
  }

  /** Call a tool on a connected server. Throws only if the server is not connected. */
  async call(serverName: string, toolName: string, args: unknown, signal: AbortSignal): Promise<McpCallResult> {
    const conn = this.connections.get(serverName);
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
    return this.connections.get(serverName)?.capabilities?.resources != null;
  }

  /** True when a connected server advertises the `prompts` capability. */
  supportsPrompts(serverName: string): boolean {
    return this.connections.get(serverName)?.capabilities?.prompts != null;
  }

  /** List a server's resources. Returns `[]` when not connected or the capability is absent. */
  async listResources(serverName: string): Promise<McpResourceDef[]> {
    const conn = this.connections.get(serverName);
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
    const conn = this.connections.get(serverName);
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
    const conn = this.connections.get(serverName);
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
    const conn = this.connections.get(serverName);
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
    for (const name of [...this.connections.keys()]) {
      await this.disposeConnection(name);
    }
  }

  private async disposeConnection(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    this.connections.delete(name);
    try {
      await conn.client.close();
    } catch {
      // Best-effort: a server that already died must not block reconciliation.
    }
  }

  /** Coalesce concurrent connects to the same server+signature into one shared attempt. */
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
    // interactive authorization, the provider throws `NeedsAuthError` (no browser) so this
    // connect fails and `sync` reports `needs_auth`.
    let authProvider: OAuthClientProvider | undefined;
    if (isHttpServer(config) && this.oauthDeps && shouldUseOAuth(config)) {
      authProvider = createConnectOAuthProvider(name, this.oauthDeps, config.oauth);
    }

    try {
      return await this.openConnection(name, config, authProvider);
    } catch (error) {
      // Some servers (e.g. Atlassian) reject an expired access token with a non-401 body, so the
      // SDK's built-in refresh (gated on HTTP 401) never fires. When we hold a refreshable OAuth
      // provider, force a silent token refresh via the SDK `auth()` and reconnect once (with a
      // fresh client + transport). If interactive login is actually required, `auth()` throws
      // `NeedsAuthError` (the connect-path provider never opens a browser) → propagates as
      // `needs_auth`.
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
 * True when a connect/refresh failure means the server needs interactive OAuth login. Covers our
 * own `NeedsAuthError` (the provider refused to open a browser), a raw SDK `UnauthorizedError`/401,
 * and OAuth token-rejection payloads (RFC 6750/6749) that some servers (e.g. Atlassian) surface as
 * a plain transport error like `{"error":"invalid_token","error_description":"Missing or invalid
 * access token"}` instead of a clean 401 — those must degrade to `needs_auth`, not a hard `error`.
 */
function isNeedsAuth(error: unknown): boolean {
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
