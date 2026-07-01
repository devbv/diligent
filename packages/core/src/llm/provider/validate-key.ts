// @summary Cheap API-key validation via a provider "list models" call, used at save time

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { ProviderName } from "../types";

const PROVIDER_LABELS: Partial<Record<ProviderName, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
};

function authStatus(err: unknown): number | undefined {
  const status =
    (err as { status?: number; response?: { status?: number } })?.status ??
    (err as { response?: { status?: number } })?.response?.status;
  return typeof status === "number" ? status : undefined;
}

// Validate a provider API key with the cheapest authenticated call available — listing models,
// a free GET that returns 401/403 on a bad key. Providers without a uniform list endpoint
// (vertex uses a Google access token, z.ai/chatgpt differ) are skipped: best-effort, saved as before.
// Throws on an invalid key so the caller can refuse to persist it.
//
// Fail fast: the SDK defaults are a 10-minute timeout with 2 automatic retries (and timeouts are
// themselves retried), so a bad key or unreachable endpoint would hang for minutes. For an
// interactive save we want a single quick attempt — no retries, a short timeout.
const VALIDATE_TIMEOUT_MS = 10_000;

export async function validateProviderApiKey(provider: ProviderName, apiKey: string, baseUrl?: string): Promise<void> {
  try {
    if (provider === "anthropic") {
      await new Anthropic({ apiKey, baseURL: baseUrl, maxRetries: 0, timeout: VALIDATE_TIMEOUT_MS }).models.list({
        limit: 1,
      });
    } else if (provider === "openai") {
      await new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0, timeout: VALIDATE_TIMEOUT_MS }).models.list();
    } else if (provider === "gemini") {
      await new GoogleGenAI({
        apiKey,
        httpOptions: { ...(baseUrl ? { baseUrl } : {}), timeout: VALIDATE_TIMEOUT_MS },
      }).models.list({ config: { pageSize: 1 } });
    }
    // Other providers: no validation (preserves prior save-anything behavior).
  } catch (err) {
    const label = PROVIDER_LABELS[provider] ?? provider;
    const status = authStatus(err);
    if (status === 401 || status === 403) {
      throw new Error(`Invalid API key for ${label}. Please check the key and try again.`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not verify the ${label} API key: ${message}`);
  }
}
