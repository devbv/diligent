// @summary Refresh OpenAI OAuth tokens using refresh_token (single-use with rotation)
import type { OpenAIOAuthTokens } from "../types";
import { CLIENT_ID, OAUTH_TOKEN_URL } from "./constants";
import { mergeOAuthRefreshTokens } from "./token-exchange";

/** Check if tokens need refresh (expire within 5 minutes) */
export function shouldRefresh(tokens: OpenAIOAuthTokens): boolean {
  return tokens.expires_at - 5 * 60 * 1000 < Date.now();
}

/** Refresh tokens. Returns new token set with rotated refresh_token. */
export async function refreshOAuthTokens(tokens: OpenAIOAuthTokens): Promise<OpenAIOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: tokens.refresh_token,
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  return mergeOAuthRefreshTokens(tokens, await res.json());
}
