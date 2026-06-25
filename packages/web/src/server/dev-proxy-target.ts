// @summary Resolves the Vite development /rpc proxy target from environment variables.

const DEFAULT_RPC_PROXY_TARGET = "ws://localhost:7433";

function stripRpcPath(url: URL): string {
  if (url.pathname === "/rpc" || url.pathname === "/rpc/") {
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }

  return url.toString().replace(/\/$/, "");
}

export function normalizeRpcProxyTarget(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return stripRpcPath(new URL(trimmed));
  } catch {
    return trimmed.replace(/\/rpc\/?$/, "");
  }
}

export function resolveDevRpcProxyTarget(env: NodeJS.ProcessEnv = process.env): string {
  return (
    normalizeRpcProxyTarget(env.DILIGENT_WEB_RPC_TARGET) ??
    normalizeRpcProxyTarget(env.VITE_DILIGENT_RPC_URL) ??
    (env.DILIGENT_WEB_SERVER_PORT?.trim() ? `ws://localhost:${env.DILIGENT_WEB_SERVER_PORT.trim()}` : undefined) ??
    DEFAULT_RPC_PROXY_TARGET
  );
}
