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

export interface RawRefreshTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
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
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return isRecord(claims) ? (claims as JwtClaims) : undefined;
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

  return parseTokenResponse(await res.json());
}

/** Convert raw token response to OpenAIOAuthTokens (extracts account_id from JWT). */
export function buildOAuthTokens(raw: unknown): OpenAIOAuthTokens {
  const parsed = parseTokenResponse(raw);
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    id_token: parsed.id_token,
    expires_at: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    account_id: extractAccountId(parsed),
    account_info: extractAccountInfo(parsed),
  };
}

/** Merge a partial refresh response over a previously validated token set. */
export function mergeOAuthRefreshTokens(previous: OpenAIOAuthTokens, raw: unknown): OpenAIOAuthTokens {
  const response = requireRecord(raw, "Token refresh response");
  const accessToken = readOptionalTokenField(response, "access_token") ?? previous.access_token;
  const refreshToken = readOptionalTokenField(response, "refresh_token") ?? previous.refresh_token;
  const replacementIdToken = readOptionalTokenField(response, "id_token");

  if (!isNonEmptyString(accessToken)) {
    throw new Error("Merged access_token must be a non-empty string");
  }
  if (!isNonEmptyString(refreshToken)) {
    throw new Error("Merged refresh_token must be a non-empty string");
  }
  if (replacementIdToken !== undefined && !parseJwtClaims(replacementIdToken)) {
    throw new Error("id_token must be a valid JWT");
  }

  const expiresIn = readValidExpiresIn(response.expires_in);
  const merged: OpenAIOAuthTokens = {
    ...previous,
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: replacementIdToken ?? previous.id_token,
    expires_at: expiresIn === undefined ? previous.expires_at : Date.now() + expiresIn * 1000,
  };

  if (replacementIdToken !== undefined) {
    const mergedRaw: RawTokenResponse = {
      access_token: merged.access_token,
      refresh_token: merged.refresh_token,
      id_token: merged.id_token,
      token_type: "Bearer",
    };
    merged.account_id = extractAccountId(mergedRaw);
    merged.account_info = extractAccountInfo(mergedRaw);
  }

  return merged;
}

function parseTokenResponse(raw: unknown): RawTokenResponse {
  const response = requireRecord(raw, "Token response");
  const expiresIn = readValidExpiresIn(response.expires_in);
  return {
    access_token: readRequiredTokenField(response, "access_token"),
    refresh_token: readRequiredTokenField(response, "refresh_token"),
    id_token: readRequiredTokenField(response, "id_token"),
    token_type: readRequiredTokenField(response, "token_type"),
    ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readRequiredTokenField(response: Record<string, unknown>, field: string): string {
  const value = response[field];
  if (!isNonEmptyString(value)) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function readOptionalTokenField(response: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(response, field)) return undefined;
  return readRequiredTokenField(response, field);
}

function readValidExpiresIn(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
