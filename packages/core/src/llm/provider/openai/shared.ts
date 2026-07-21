// @summary Shared OpenAI transient-error classification and structured compaction decoding
import { isNetworkError } from "../../errors";
import { classifyProviderHttpError } from "../../provider-errors";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE, ProviderError, ProviderErrorReason, ProviderErrorType } from "../../types";
import { isContextOverflow } from "./responses";

export { extractOpenAICompactionState } from "./compaction-state";

export interface ClassifyOpenAIFamilyErrorOptions {
  message: string;
  status?: number;
  code?: string;
  cause?: Error;
  retryAfterMs?: number;
}

export interface OpenAIStreamIdleTimeoutOptions {
  idleTimeoutMs: number;
  message: string;
  signal?: AbortSignal;
  onTimeout?: (error: ProviderError) => void | Promise<void>;
  onAbort?: (reason: unknown) => void | Promise<void>;
}

/** Classify OpenAI-family failures in provider-code, status, message, fallback order. */
export function classifyOpenAIFamilyError(options: ClassifyOpenAIFamilyErrorOptions): ProviderError {
  const { message, status, retryAfterMs } = options;
  const code = normalizeProviderCode(options.code);
  const cause = preserveErrorCode(options.cause, options.code, message);
  const providerError = (input: {
    errorType: ProviderErrorType;
    isRetryable: boolean;
    reason?: ProviderErrorReason;
    normalizedMessage?: string;
  }): ProviderError =>
    new ProviderError(input.normalizedMessage ?? message, {
      errorType: input.errorType,
      isRetryable: input.isRetryable,
      retryAfterMs,
      statusCode: status,
      cause,
      reason: input.reason,
    });

  if (code) {
    if (isContextCode(code)) {
      return providerError({
        errorType: ProviderErrorType.ContextOverflow,
        isRetryable: false,
        reason: ProviderErrorReason.ContextWindowExceeded,
        normalizedMessage: CONTEXT_OVERFLOW_ERROR_MESSAGE,
      });
    }
    if (isUsageLimitCode(code)) {
      return providerError({
        errorType: ProviderErrorType.RateLimit,
        isRetryable: false,
        reason: ProviderErrorReason.UsageLimitReached,
      });
    }
    if (isTransientRateLimitCode(code)) {
      return providerError({ errorType: ProviderErrorType.RateLimit, isRetryable: true });
    }
    if (isAuthenticationCode(code)) {
      return providerError({
        errorType: ProviderErrorType.Auth,
        isRetryable: false,
        reason: ProviderErrorReason.CredentialsRejected,
      });
    }
    if (isServerCode(code)) {
      return providerError({ errorType: ProviderErrorType.ServerError, isRetryable: true });
    }
    if (isPolicyCode(code)) {
      return providerError({ errorType: ProviderErrorType.Unknown, isRetryable: false });
    }
  }

  const httpError = classifyProviderHttpError({ message, status, cause, retryAfterMs });
  if (httpError) return httpError;

  if (isContextOverflow(message)) {
    return providerError({
      errorType: ProviderErrorType.ContextOverflow,
      isRetryable: false,
      reason: ProviderErrorReason.ContextWindowExceeded,
      normalizedMessage: CONTEXT_OVERFLOW_ERROR_MESSAGE,
    });
  }
  if (isUsageLimitMessage(message)) {
    return providerError({
      errorType: ProviderErrorType.RateLimit,
      isRetryable: false,
      reason: ProviderErrorReason.UsageLimitReached,
    });
  }
  if (isTransientOpenAIErrorMessage(message)) {
    return providerError({ errorType: ProviderErrorType.ServerError, isRetryable: true });
  }
  if (cause && isNetworkError(cause)) {
    return providerError({ errorType: ProviderErrorType.Network, isRetryable: true });
  }
  return providerError({ errorType: ProviderErrorType.Unknown, isRetryable: false });
}

export function parseOpenAIRetryAfter(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const milliseconds = parsePositiveNumber(headers.get("retry-after-ms"));
  if (milliseconds !== undefined) return milliseconds;
  const seconds = parsePositiveNumber(headers.get("retry-after"));
  return seconds === undefined ? undefined : seconds * 1000;
}

/** Apply a per-event idle deadline to an async iterable without limiting total stream duration. */
export async function* iterateOpenAIStreamWithIdleTimeout<T>(
  iterable: AsyncIterable<T>,
  options: OpenAIStreamIdleTimeoutOptions,
): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      let result: IteratorResult<T>;
      try {
        result = await waitForOpenAIStreamProgress(iterator.next(), options);
      } catch (error) {
        if (options.signal?.aborted) return;
        throw error;
      }
      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!completed) {
      try {
        const returned = iterator.return?.();
        if (returned) void returned.catch(() => {});
      } catch {
        // The timeout or caller abort is already the authoritative terminal result.
      }
    }
  }
}

/** Wait for one body chunk or SDK event and reject only when that individual wait is idle. */
export function waitForOpenAIStreamProgress<T>(
  pending: Promise<T>,
  options: OpenAIStreamIdleTimeoutOptions,
): Promise<T> {
  const idleTimeoutMs = Math.max(1, options.idleTimeoutMs);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", handleAbort);
    };
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const runCleanupHook = (hookResult: void | Promise<void>): void => {
      if (hookResult instanceof Promise) void hookResult.catch(() => {});
    };
    const handleAbort = (): void => {
      settle(() => {
        pending.catch(() => {});
        runCleanupHook(options.onAbort?.(options.signal?.reason));
        reject(options.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      });
    };
    const timer = setTimeout(() => {
      if (options.signal?.aborted) {
        handleAbort();
        return;
      }
      settle(() => {
        const error = new ProviderError(options.message, ProviderErrorType.Network, true);
        pending.catch(() => {});
        runCleanupHook(options.onTimeout?.(error));
        reject(error);
      });
    }, idleTimeoutMs);

    if (options.signal?.aborted) {
      handleAbort();
      return;
    }
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    pending.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

/** Shared by SDK exceptions, ChatGPT fetch, and mid-stream failure events. */
export function isTransientOpenAIErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("overloaded") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("can retry your request") ||
    normalized.includes("service unavailable") ||
    normalized.includes("server had an error") ||
    normalized.includes("internal server error")
  );
}

function normalizeProviderCode(code: string | undefined): string | undefined {
  const normalized = code?.trim().toLowerCase();
  return normalized || undefined;
}

function isContextCode(code: string): boolean {
  return code === "context_length_exceeded" || code === "context_window_exceeded";
}

function isUsageLimitCode(code: string): boolean {
  return (
    code === "insufficient_quota" ||
    code === "billing_hard_limit_reached" ||
    code.includes("usage_limit") ||
    code.includes("quota_exceeded")
  );
}

function isTransientRateLimitCode(code: string): boolean {
  return code === "rate_limit_exceeded" || code === "rate_limit" || code.includes("connection_limit_reached");
}

function isAuthenticationCode(code: string): boolean {
  return (
    code === "invalid_api_key" ||
    code === "authentication_error" ||
    code === "invalid_authentication" ||
    code === "unauthorized" ||
    code === "permission_denied" ||
    code === "account_deactivated"
  );
}

function isServerCode(code: string): boolean {
  return code === "server_error" || code === "overloaded" || code === "service_unavailable";
}

function isPolicyCode(code: string): boolean {
  return code === "invalid_prompt" || code === "bio_policy" || code.includes("policy_violation");
}

function isUsageLimitMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("usage_limit_reached") || normalized.includes("usage limit has been reached");
}

function preserveErrorCode(cause: Error | undefined, code: string | undefined, message: string): Error | undefined {
  if (!code) return cause;
  if (readErrorCode(cause) === code) return cause;
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function readErrorCode(error: Error | undefined): string | undefined {
  if (!error) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function parsePositiveNumber(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function summarizeOutputShape(output: unknown): string {
  if (!Array.isArray(output)) return "none";
  const shapes = output.slice(0, 8).map((rawItem) => {
    if (!rawItem || typeof rawItem !== "object") return "unknown";
    const item = rawItem as Record<string, unknown>;
    return typeof item.type === "string" ? item.type : "unknown";
  });
  return shapes.join(";") || "empty";
}

function countStructuredCompactionItems(output: unknown): number {
  if (!Array.isArray(output)) return 0;
  return output.filter(
    (item) =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as Record<string, unknown>).type === "compaction" &&
      typeof (item as Record<string, unknown>).encrypted_content === "string",
  ).length;
}

export function describeCompactionPayload(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload);
  const topKeys = keys.length > 0 ? keys.slice(0, 8).join(",") : "none";
  const outputLen = Array.isArray(payload.output) ? payload.output.length : 0;
  return `payload_keys=${topKeys} output_items=${outputLen} output_shape=${summarizeOutputShape(payload.output)} structured_compaction_items=${countStructuredCompactionItems(payload.output)}`;
}

export function extractCompactionSummaryItem(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(payload.output)) return undefined;
  for (const rawItem of payload.output) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type === "compaction" && typeof item.encrypted_content === "string") {
      return { type: "compaction", encrypted_content: item.encrypted_content };
    }
  }
  return undefined;
}
