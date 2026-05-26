// @summary OpenAI OAuth token exchange — authorization code → tokens + JWT account metadata extraction
import type { OpenAIAccountInfo, OpenAIOAuthTokens } from "../types";
import { CLIENT_ID, OAUTH_TOKEN_URL, REDIRECT_URI } from "./constants";

export interface RawTokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in?: number;
  token_type: string;
}

interface JwtClaims {
  email?: string;
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  "https://api.openai.com/auth"?: {
    chatgpt_plan_type?: string;
    chatgpt_user_id?: string;
    chatgpt_account_id?: string;
    chatgpt_account_is_fedramp?: boolean;
  };
}

/** Parse a JWT and return its payload claims (no verification). */
export function parseJwtClaims(token: string): JwtClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return undefined;
  }
}

/** Extract ChatGPT account_id from JWT claims (id_token or access_token). */
export function extractAccountId(raw: RawTokenResponse): string | undefined {
  for (const token of [raw.id_token, raw.access_token]) {
    if (!token) continue;
    const claims = parseJwtClaims(token);
    if (!claims) continue;
    const id =
      claims.chatgpt_account_id ??
      claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
      claims.organizations?.[0]?.id;
    if (id) return id;
  }
  return undefined;
}

/** Extract provider account metadata from the ID token JWT claims. */
export function extractAccountInfo(raw: RawTokenResponse): OpenAIAccountInfo | undefined {
  const claims = parseJwtClaims(raw.id_token);
  if (!claims) return undefined;

  const openaiAuth = claims["https://api.openai.com/auth"];
  const accountInfo: OpenAIAccountInfo = {
    email: claims.email,
    chatgpt_plan_type: openaiAuth?.chatgpt_plan_type,
    chatgpt_user_id: openaiAuth?.chatgpt_user_id,
    chatgpt_account_id: openaiAuth?.chatgpt_account_id ?? claims.chatgpt_account_id,
    chatgpt_account_is_fedramp: openaiAuth?.chatgpt_account_is_fedramp,
  };

  return Object.values(accountInfo).some((value) => value !== undefined) ? accountInfo : undefined;
}

/** Exchange authorization code for tokens */
export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<RawTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<RawTokenResponse>;
}

/** Convert raw token response to OpenAIOAuthTokens (extracts account_id from JWT). */
export function buildOAuthTokens(raw: RawTokenResponse): OpenAIOAuthTokens {
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    id_token: raw.id_token,
    expires_at: Date.now() + (raw.expires_in ?? 3600) * 1000,
    account_id: extractAccountId(raw),
    account_info: extractAccountInfo(raw),
  };
}
