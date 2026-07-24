// @summary RPC helpers for provider authentication (list, set, remove, OAuth start/cancel)
import type {
  AuthListResponse,
  AuthOAuthCancelResponse,
  AuthOAuthStartResponse,
  ProviderName,
} from "@diligent/protocol";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import type { WebRpcClient } from "./rpc-client";

export type { AuthListResponse };

export async function fetchProviderStatus(rpc: WebRpcClient): Promise<AuthListResponse> {
  return rpc.webRequest(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_LIST, {});
}

export async function setProviderKey(rpc: WebRpcClient, provider: string, apiKey: string): Promise<void> {
  await rpc.webRequest(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_SET, { provider: provider as ProviderName, apiKey });
}

export async function removeProviderKey(rpc: WebRpcClient, provider: string): Promise<void> {
  await rpc.webRequest(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_REMOVE, { provider: provider as ProviderName });
}

export async function startOAuthFlow(rpc: WebRpcClient, provider: ProviderName): Promise<AuthOAuthStartResponse> {
  if (provider !== "chatgpt") {
    throw new Error("OAuth login is only supported for chatgpt provider");
  }
  return rpc.webRequest(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_OAUTH_START, { provider });
}

export async function cancelOAuthFlow(rpc: WebRpcClient, provider: ProviderName): Promise<AuthOAuthCancelResponse> {
  if (provider !== "chatgpt") {
    throw new Error("OAuth cancel is only supported for chatgpt provider");
  }
  return rpc.webRequest(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_OAUTH_CANCEL, { provider });
}
