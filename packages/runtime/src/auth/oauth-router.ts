// @summary Generic OAuth PKCE flow runner shared across provider OAuth implementations
import { openBrowser as defaultOpenBrowser } from "./browser";
import { waitForCallback } from "./callback-server";

export interface OAuthRequest {
  authUrl: string;
  state: string;
  codeVerifier: string;
}

export interface OAuthProviderConfig<TTokens> {
  createRequest(): OAuthRequest;
  exchangeCode(code: string, codeVerifier: string): Promise<TTokens>;
}

export interface OAuthFlowOptions {
  onUrl?: (url: string) => void;
  timeoutMs?: number;
  openBrowser?: (url: string) => void;
  signal?: AbortSignal;
}

export async function runOAuthFlow<TTokens>(
  provider: OAuthProviderConfig<TTokens>,
  options: OAuthFlowOptions = {},
): Promise<TTokens> {
  const request = provider.createRequest();
  options.onUrl?.(request.authUrl);

  const opener = options.openBrowser ?? defaultOpenBrowser;
  opener(request.authUrl);

  const { code } = await waitForCallback(request.state, options.timeoutMs, options.signal);
  return provider.exchangeCode(code, request.codeVerifier);
}
