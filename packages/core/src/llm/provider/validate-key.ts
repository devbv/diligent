// @summary Provider-neutral API-key validation using cheap authenticated HTTP requests
import { isAuthenticationStatus } from "../provider-errors";
import { ProviderError, ProviderErrorReason, ProviderErrorType, type ProviderName } from "../types";
import { resolveZaiCodingPlanBaseUrl } from "./zai-coding-plan";

const VALIDATE_TIMEOUT_MS = 10_000;
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

type KeyValidator = (apiKey: string, baseUrl?: string, model?: string) => Promise<void>;

const KEY_VALIDATORS: Partial<Record<ProviderName, KeyValidator>> = {
  anthropic: validateAnthropicKey,
  openai: validateOpenAIKey,
  gemini: validateGeminiKey,
  "zai-coding-plan": validateZaiCodingPlanKey,
};

export async function validateProviderApiKey(
  provider: ProviderName,
  apiKey: string,
  baseUrl?: string,
  model?: string,
): Promise<void> {
  const validator = KEY_VALIDATORS[provider];
  if (!validator) return;

  try {
    await validator(apiKey, baseUrl, model);
  } catch (err) {
    const status = authStatus(err);
    const message = err instanceof Error ? err.message : String(err);
    if (isAuthenticationStatus(status)) {
      throw new ProviderError(message, {
        errorType: ProviderErrorType.Auth,
        isRetryable: false,
        statusCode: status,
        cause: err instanceof Error ? err : undefined,
        reason: ProviderErrorReason.CredentialsRejected,
      });
    }
    throw new ProviderError(message, {
      errorType: ProviderErrorType.Unknown,
      isRetryable: false,
      statusCode: status,
      cause: err instanceof Error ? err : undefined,
    });
  }
}

async function validateAnthropicKey(apiKey: string, baseUrl?: string): Promise<void> {
  await requestValidation(joinUrl(baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL, "v1/models?limit=1"), {
    headers: {
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey,
    },
  });
}

async function validateOpenAIKey(apiKey: string, baseUrl?: string): Promise<void> {
  await requestValidation(joinUrl(baseUrl ?? DEFAULT_OPENAI_BASE_URL, "models"), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

async function validateGeminiKey(apiKey: string, baseUrl?: string): Promise<void> {
  await requestValidation(joinUrl(baseUrl ?? DEFAULT_GEMINI_BASE_URL, "models?pageSize=1"), {
    headers: { "x-goog-api-key": apiKey },
  });
}

// z.ai does not expose a dependable models-list endpoint for Coding Plan keys, so use the
// same endpoint as generation with the smallest possible non-streaming completion.
async function validateZaiCodingPlanKey(apiKey: string, baseUrl?: string, model?: string): Promise<void> {
  await requestValidation(joinUrl(resolveZaiCodingPlanBaseUrl(baseUrl), "chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model ?? "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      stream: false,
    }),
  });
}

async function requestValidation(url: string, init: RequestInit): Promise<void> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) });
  if (response.ok) return;
  const body = (await response.text().catch(() => "")).trim();
  throw Object.assign(new Error(body || `Provider API error (${response.status})`), { status: response.status });
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function authStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const record = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const status = record.statusCode ?? record.status ?? record.response?.status;
  return typeof status === "number" ? status : undefined;
}
