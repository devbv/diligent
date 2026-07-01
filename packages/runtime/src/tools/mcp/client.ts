// @summary MCP connection manager — signature-keyed connect/list/call with per-server isolation

import { createHash } from "node:crypto";
import { DILIGENT_VERSION } from "@diligent/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpOAuthDeps, McpOAuthHandle } from "./oauth";
import { createMcpOAuthHandle, resolveAuthHeaders, shouldUseOAuth } from "./oauth";
import {
  DEFAULT_MCP_STARTUP_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  isHttpServer,
  isStdioServer,
  type McpCallResult,
  type McpServerConfig,
  type McpServerRuntime,
  type McpToolDef,
} from "./types";

interface ActiveConnection {
  signature: string;
  client: Client;
  transport: Transport;
  tools: McpToolDef[];
  toolTimeoutMs: number;
}

/** Interactive OAuth login is allowed a longer budget than a plain connect. */
const OAUTH_LOGIN_TIMEOUT_MS = 180_000;

/**
 * Builds the transport for a server. Injectable so tests can supply an in-memory
 * transport pair linked to a real MCP server without spawning processes or sockets.
 */
export type McpTransportFactory = (
  name: string,
  config: McpServerConfig,
  oauth: McpOAuthHandle | undefined,
) => Promise<Transport> | Transport;

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

function mapToolDefs(tools: Awaited<ReturnType<Client["listTools"]>>["tools"]): McpToolDef[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
    readOnly: tool.annotations?.readOnlyHint === true,
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
  private oauthDeps: McpOAuthDeps | undefined;

  constructor(private readonly transportFactory?: McpTransportFactory) {}

  /** Wire interactive-OAuth dependencies (browser opener + token store dir). Optional. */
  setOAuthDeps(deps: McpOAuthDeps | undefined): void {
    this.oauthDeps = deps;
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
      }
    }

    const results = await Promise.all(
      [...desired.entries()].map(async ([name, config]): Promise<McpServerRuntime> => {
        const existing = this.connections.get(name);
        if (existing) {
          return { name, status: "connected", tools: existing.tools };
        }
        try {
          const conn = await this.connectDeduped(name, config);
          this.connections.set(name, conn);
          return { name, status: "connected", tools: conn.tools };
        } catch (error) {
          return { name, status: "error", tools: [], error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );

    return results;
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
    const signature = stableSignature(name, config);
    const startupTimeoutMs = timeoutOf(config, "startupTimeoutMs", DEFAULT_MCP_STARTUP_TIMEOUT_MS);
    const toolTimeoutMs = timeoutOf(config, "toolTimeoutMs", DEFAULT_MCP_TOOL_TIMEOUT_MS);
    const client = new Client({ name: "diligent", version: DILIGENT_VERSION }, { capabilities: {} });

    let oauth: McpOAuthHandle | undefined;
    if (isHttpServer(config) && this.oauthDeps && shouldUseOAuth(config)) {
      oauth = createMcpOAuthHandle(name, this.oauthDeps, config.oauth);
    }

    let transport = await this.createTransport(name, config, oauth);
    try {
      await withTimeout(client.connect(transport), startupTimeoutMs, `MCP "${name}" connect`, () => {
        void transport.close?.();
      });
    } catch (error) {
      if (oauth && isUnauthorized(error)) {
        // Complete the interactive login on the pending transport, then reconnect with a
        // fresh transport: an SDK transport cannot be started twice, and the new one picks
        // up the tokens the provider just persisted.
        const code = await oauth.waitForCallback(OAUTH_LOGIN_TIMEOUT_MS);
        await (transport as StreamableHTTPClientTransport).finishAuth(code);
        transport = await this.createTransport(name, config, oauth);
        await withTimeout(client.connect(transport), startupTimeoutMs, `MCP "${name}" reconnect`, () => {
          void transport.close?.();
        });
      } else {
        oauth?.close();
        throw error;
      }
    }

    const listed = await withTimeout(client.listTools(), startupTimeoutMs, `MCP "${name}" listTools`, () => {
      void client.close();
    });
    oauth?.close();
    return { signature, client, transport, tools: mapToolDefs(listed.tools), toolTimeoutMs };
  }

  private async createTransport(
    name: string,
    config: McpServerConfig,
    oauth: McpOAuthHandle | undefined,
  ): Promise<Transport> {
    if (this.transportFactory) {
      return this.transportFactory(name, config, oauth);
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
        return new SSEClientTransport(new URL(config.url), { requestInit, authProvider: oauth?.provider });
      }
      return new StreamableHTTPClientTransport(new URL(config.url), { requestInit, authProvider: oauth?.provider });
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

function isUnauthorized(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  const message = error instanceof Error ? error.message : String(error);
  return name === "UnauthorizedError" || /unauthorized|401/i.test(message);
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
