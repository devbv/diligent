// @summary Interactive ChatGPT OAuth flow built on core protocol helpers
import type { OpenAIOAuthTokens } from "@diligent/core/auth";
import { buildOAuthTokens, createChatGPTOAuthRequest, exchangeCodeForTokens } from "@diligent/core/auth/chatgpt-oauth";
import { openBrowser as defaultOpenBrowser } from "./browser";
import { waitForCallback } from "./callback-server";

export interface OAuthFlowOptions {
  onUrl?: (url: string) => void;
  timeoutMs?: number;
  openBrowser?: (url: string) => void;
  signal?: AbortSignal;
}

export async function runChatGPTOAuth(options: OAuthFlowOptions = {}): Promise<OpenAIOAuthTokens> {
  const request = createChatGPTOAuthRequest();
  options.onUrl?.(request.authUrl);

  const opener = options.openBrowser ?? defaultOpenBrowser;
  opener(request.authUrl);

  const { code } = await waitForCallback(request.state, options.timeoutMs, options.signal);
  const rawTokens = await exchangeCodeForTokens(code, request.codeVerifier);
  return buildOAuthTokens(rawTokens);
}
