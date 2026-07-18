// @summary z.ai Coding Plan adapter built on the Vercel AI SDK compatible provider
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { isNetworkError } from "../../errors";
import { classifyProviderHttpError } from "../../provider-errors";
import type { Model, StreamFunction, StreamOptions } from "../../types";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE, ProviderError, ProviderErrorReason, ProviderErrorType } from "../../types";
import { createAISDKStream } from "../ai-sdk";
import { isContextOverflow } from "../openai/responses";

const DEFAULT_ZAI_CODING_PLAN_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

export function createZaiCodingPlanStream(apiKey?: string, baseUrl?: string): StreamFunction {
  return createAISDKStream({
    createLanguageModel: (model) => {
      const provider = createOpenAICompatible({
        name: "zai-coding-plan",
        baseURL: resolveZaiCodingPlanBaseUrl(baseUrl),
        apiKey: resolveZaiCodingPlanApiKey(apiKey),
        includeUsage: true,
        transformRequestBody: transformZaiCodingPlanRequest,
      });
      return provider.chatModel(model.modelId);
    },
    classifyError: classifyZaiCodingPlanError,
    buildProviderOptions: buildZaiCodingPlanProviderOptions,
    // z.ai accepts Diligent's effort strings directly through reasoning_effort.
    resolveReasoning: () => undefined,
  });
}

export function buildZaiCodingPlanProviderOptions(model: Model, options: StreamOptions) {
  if (!model.supportsThinking || options.effort === undefined) return undefined;
  return { zaiCodingPlan: { reasoningEffort: options.effort } };
}

export function transformZaiCodingPlanRequest(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.reasoning_effort !== "string") return body;
  return { ...body, thinking: { type: "enabled" } };
}

export function classifyZaiCodingPlanError(err: unknown): ProviderError {
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

function resolveZaiCodingPlanApiKey(apiKey?: string): string {
  const resolved = apiKey?.trim() || process.env.ZAI_CODING_PLAN_API_KEY?.trim();
  if (resolved) return resolved;
  throw new Error(
    "z.ai Coding Plan API key is required. Set ZAI_CODING_PLAN_API_KEY or pass apiKey to createZaiCodingPlanStream().",
  );
}

export function resolveZaiCodingPlanBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? DEFAULT_ZAI_CODING_PLAN_BASE_URL).replace(/\/+$/, "");
}
