// @summary Vertex OpenAI endpoint adapter built on the Vercel AI SDK compatible provider
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { isNetworkError } from "../errors";
import { classifyProviderHttpError } from "../provider-errors";
import type { StreamFunction } from "../types";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE, ProviderError, ProviderErrorReason, ProviderErrorType } from "../types";
import { createAISDKStream } from "./ai-sdk";
import { isContextOverflow } from "./openai/responses";

export interface VertexStreamConfig {
  baseUrl?: string;
  modelMap?: Record<string, string>;
}

const DEFAULT_OPENAPI_MODEL_MAP: Record<string, string> = {
  "vertex-gemma-4-26b-it": "google/gemma-4-26b-a4b-it-maas",
};

export function createVertexStream(getAccessToken: () => string, config?: VertexStreamConfig): StreamFunction {
  return createAISDKStream({
    createLanguageModel: (model) => {
      const token = getAccessToken().trim();
      if (!token) throw new Error("Vertex access token is empty");
      const baseURL = resolveVertexBaseUrl(config?.baseUrl);
      const provider = createOpenAICompatible({
        name: "vertex",
        baseURL,
        apiKey: token,
        includeUsage: true,
      });
      return provider.chatModel(resolveVertexModelId(model.id, baseURL, config?.modelMap));
    },
    classifyError: classifyVertexError,
  });
}

export function classifyVertexError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (isNetworkError(err)) {
    return new ProviderError(
      String(err),
      ProviderErrorType.Network,
      true,
      undefined,
      undefined,
      err instanceof Error ? err : undefined,
    );
  }
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    const status =
      typeof record.statusCode === "number"
        ? record.statusCode
        : typeof record.status === "number"
          ? record.status
          : undefined;
    const message =
      typeof record.message === "string" ? record.message : err instanceof Error ? err.message : String(err);
    if (status === 400 && isContextOverflow(message)) {
      return new ProviderError(CONTEXT_OVERFLOW_ERROR_MESSAGE, {
        errorType: ProviderErrorType.ContextOverflow,
        isRetryable: false,
        statusCode: status,
        reason: ProviderErrorReason.ContextWindowExceeded,
      });
    }
    const httpError = classifyProviderHttpError({
      message,
      status,
      cause: err instanceof Error ? err : undefined,
    });
    if (httpError) return httpError;
    return new ProviderError(
      message,
      ProviderErrorType.Unknown,
      false,
      undefined,
      status,
      err instanceof Error ? err : undefined,
    );
  }
  return new ProviderError(String(err), ProviderErrorType.Unknown, false);
}

function resolveVertexBaseUrl(baseUrl?: string): string {
  if (!baseUrl) throw new Error("Vertex baseUrl is required");
  return baseUrl.replace(/\/+$/, "");
}

export function resolveVertexModelId(modelId: string, baseUrl: string, modelMap?: Record<string, string>): string {
  const explicit = modelMap?.[modelId];
  if (explicit) return explicit;
  if (baseUrl.endsWith("/endpoints/openapi")) {
    return DEFAULT_OPENAPI_MODEL_MAP[modelId] ?? modelId;
  }
  return modelId;
}
