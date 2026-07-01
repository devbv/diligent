// @summary App-server MCP server management handlers: list / login / logout (P070)

import {
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  type DiligentServerNotification,
  type McpListResponse,
  type McpLoginStartResponse,
  type McpLogoutResponse,
} from "@diligent/protocol";
import type { DiligentConfig } from "../config/schema";
import { getMcpManager } from "../tools/mcp";

type EmitFn = (notification: DiligentServerNotification) => Promise<void>;
type GetMcpServers = () => DiligentConfig["mcpServers"];

/** Minimal deferred so login-start can return the auth URL as soon as it is known. */
function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** `mcp/list` — report every configured server's status without forcing a reconnect. */
export async function handleMcpList(getMcpServers: GetMcpServers): Promise<McpListResponse> {
  const servers = getMcpServers() ?? {};
  return { servers: await getMcpManager().listStatus(servers) };
}

/**
 * `mcp/login/start` — kick off interactive OAuth for an HTTP server. Returns the authorization
 * URL as soon as the SDK produces it (server also opens the browser); the connect+token exchange
 * finishes in the background and broadcasts `mcp/login/completed`.
 */
export async function handleMcpLoginStart(args: {
  server: string;
  getMcpServers: GetMcpServers;
  emit: EmitFn;
}): Promise<McpLoginStartResponse> {
  const config = args.getMcpServers()?.[args.server];
  if (!config) {
    throw Object.assign(new Error(`Unknown MCP server "${args.server}"`), { code: -32602 });
  }

  const authUrl = defer<string>();
  const complete = getMcpManager().login(args.server, config, {
    onAuthUrl: (url) => authUrl.resolve(url),
  });

  void complete.then(
    ({ toolCount }) => {
      authUrl.resolve(""); // no-op if a redirect URL already resolved it (e.g. silent re-auth)
      return args.emit({
        method: DILIGENT_SERVER_NOTIFICATION_METHODS.MCP_LOGIN_COMPLETED,
        params: { server: args.server, success: true, toolCount, error: null },
      });
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      authUrl.reject(error instanceof Error ? error : new Error(message)); // no-op if already resolved
      return args.emit({
        method: DILIGENT_SERVER_NOTIFICATION_METHODS.MCP_LOGIN_COMPLETED,
        params: { server: args.server, success: false, error: message },
      });
    },
  );

  return { authUrl: await authUrl.promise };
}

/** `mcp/logout` — clear stored credentials and drop the live connection. */
export async function handleMcpLogout(args: {
  server: string;
  getMcpServers: GetMcpServers;
}): Promise<McpLogoutResponse> {
  const config = args.getMcpServers()?.[args.server];
  await getMcpManager().logout(args.server, config);
  return { ok: true };
}
