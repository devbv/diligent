// @summary Wraps stream functions with exponential backoff retry logic

import { createLogger, type Logger } from "@diligent/logging";
import { EventStream } from "../event-stream";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction, StreamOptions } from "./types";
import { ProviderError, ProviderErrorType } from "./types";

export interface RetryConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

const defaultRetryLogger = createLogger({ scope: "llm:retry" });

type DoneEvent = Extract<ProviderEvent, { type: "done" }>;
type AttemptOutputState = "none" | "discardable_draft" | "completed_tool_call";
type AttemptFailureSource = "stream_error" | "stream_exception" | "stream_ended";
type RetryStopReason = "tool_call_already_completed" | "not_retryable" | "max_attempts_reached";

type AttemptResult =
  | { type: "success"; event: DoneEvent }
  | {
      type: "failure";
      source: AttemptFailureSource;
      error: ProviderError;
      outputState: AttemptOutputState;
    };

type RetryDecision = { type: "retry"; delayMs: number } | { type: "stop"; reason: RetryStopReason };

const RETRY_LOG_DEFINITIONS = {
  retry_aborted: { level: "info", message: "provider retries aborted" },
  retry_attempt_failed: { level: "warn", message: "provider attempt failed" },
  retry_exhausted: { level: "error", message: "provider retries exhausted" },
  retry_recovered: { level: "info", message: "provider request recovered" },
  retry_scheduled: { level: "info", message: "provider retry scheduled" },
  retry_wrapper_failed: { level: "error", message: "retry wrapper failed" },
} as const;

type RetryLogEvent = keyof typeof RETRY_LOG_DEFINITIONS;

function assertRetryConfig(config: RetryConfig): void {
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts <= 0) {
    throw new TypeError("maxAttempts must be a positive integer");
  }
  if (!Number.isFinite(config.baseDelayMs) || config.baseDelayMs < 0) {
    throw new TypeError("baseDelayMs must be a non-negative finite number");
  }
  if (!Number.isFinite(config.maxDelayMs) || config.maxDelayMs < 0) {
    throw new TypeError("maxDelayMs must be a non-negative finite number");
  }
}

// Only events that create a downstream draft require a retry discard signal.
// A completed tool call is a stronger boundary because replay could duplicate side effects.
function updateOutputState(current: AttemptOutputState, event: ProviderEvent): AttemptOutputState {
  if (current === "completed_tool_call") return current;

  switch (event.type) {
    case "tool_call_end":
      return "completed_tool_call";
    case "text_delta":
    case "thinking_delta":
    case "content_block":
    case "tool_call_start":
    case "tool_call_delta":
      return "discardable_draft";
    case "start":
    case "usage":
    case "retry":
    case "text_end":
    case "thinking_end":
    case "done":
    case "error":
      return current;
    default: {
      const unhandledEvent: never = event;
      return unhandledEvent;
    }
  }
}

function toProviderError(err: unknown): ProviderError {
  return err instanceof ProviderError
    ? err
    : new ProviderError(err instanceof Error ? err.message : String(err), ProviderErrorType.Unknown, false);
}

function errorFields(error: ProviderError): Record<string, unknown> {
  const errorCode = providerErrorCode(error);
  return {
    errorType: error.errorType,
    retryable: error.isRetryable,
    ...(error.reason !== undefined && { errorReason: error.reason }),
    ...(errorCode !== undefined && { errorCode }),
    ...(error.retryAfterMs !== undefined && { retryAfterMs: error.retryAfterMs }),
    ...(error.statusCode !== undefined && { statusCode: error.statusCode }),
  };
}

function providerErrorCode(error: ProviderError): string | undefined {
  for (const candidate of [error.cause, error]) {
    const code = (candidate as (Error & { code?: unknown }) | undefined)?.code;
    if (typeof code === "string" && code.trim().length > 0) return code;
  }
  return undefined;
}

function logRetry(logger: Logger, event: RetryLogEvent, fields: Record<string, unknown>, error?: ProviderError): void {
  const definition = RETRY_LOG_DEFINITIONS[event];
  logger[definition.level](event, {
    message: `[llm:retry] ${definition.message}`,
    fields,
    ...(error && { error }),
  });
}

async function runAttempt(
  streamFn: StreamFunction,
  model: Model,
  context: StreamContext,
  options: StreamOptions,
  output: EventStream<ProviderEvent, ProviderResult>,
): Promise<AttemptResult> {
  let outputState: AttemptOutputState = "none";
  let inner: ReturnType<StreamFunction> | undefined;

  try {
    inner = streamFn(model, context, options);

    for await (const event of inner) {
      if (event.type === "error") {
        return {
          type: "failure",
          source: "stream_error",
          error: toProviderError(event.error),
          outputState,
        };
      }

      if (event.type === "done") return { type: "success", event };

      outputState = updateOutputState(outputState, event);
      output.push(event);
    }
  } catch (error) {
    return {
      type: "failure",
      source: "stream_exception",
      error: toProviderError(error),
      outputState,
    };
  } finally {
    // EventStream exposes terminal errors through result() as well as iteration.
    // Consume that rejection before waiting for provider-owned cleanup.
    inner?.result().catch(() => {});
    await inner?.waitForInnerWork();
  }

  const error = new ProviderError(
    "Provider stream ended without producing a terminal event",
    ProviderErrorType.Network,
    true,
  );
  return {
    type: "failure",
    source: "stream_ended",
    error,
    outputState,
  };
}

function logAttemptFailure(
  logger: Logger,
  failure: Extract<AttemptResult, { type: "failure" }>,
  attempt: number,
  maxAttempts: number,
): void {
  const { error, source } = failure;
  logRetry(
    logger,
    "retry_attempt_failed",
    { attempt, maxAttempts, failureSource: source, ...errorFields(error) },
    error,
  );
}

function decideRetry(
  failure: Extract<AttemptResult, { type: "failure" }>,
  attempt: number,
  config: RetryConfig,
): RetryDecision {
  if (failure.outputState === "completed_tool_call") {
    return { type: "stop", reason: "tool_call_already_completed" };
  }
  if (!failure.error.isRetryable) return { type: "stop", reason: "not_retryable" };
  if (attempt >= config.maxAttempts) return { type: "stop", reason: "max_attempts_reached" };

  const exponentialDelay = config.baseDelayMs * 2 ** (attempt - 1);
  const delayMs = Math.min(Math.max(exponentialDelay, failure.error.retryAfterMs ?? 0), config.maxDelayMs);
  return { type: "retry", delayMs };
}

function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wraps a StreamFunction with exponential backoff retry.
 * Only retries on retryable errors. Respects retry-after headers. (D010)
 */
export function withRetry(
  streamFn: StreamFunction,
  config: RetryConfig,
  onRetry?: (attempt: number, delayMs: number, error: ProviderError) => void,
  logger: Logger = defaultRetryLogger,
): StreamFunction {
  const retryConfig = { ...config };
  assertRetryConfig(retryConfig);

  return (model, context, options) => {
    const retryLogger = logger.child({
      ...(options.sessionId !== undefined && { sessionId: options.sessionId }),
      fields: { provider: model.provider, model: model.modelId },
    });
    const signal = options.signal;
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );
    const work = (async () => {
      for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
        if (signal?.aborted) {
          logRetry(retryLogger, "retry_aborted", { attempt, maxAttempts: retryConfig.maxAttempts });
          stream.push({
            type: "error",
            error: new ProviderError("Aborted", ProviderErrorType.Unknown, false),
          });
          return;
        }

        const result = await runAttempt(streamFn, model, context, options, stream);
        if (result.type === "success") {
          if (attempt > 1) {
            logRetry(retryLogger, "retry_recovered", { attempt, maxAttempts: retryConfig.maxAttempts });
          }
          stream.push(result.event);
          return;
        }

        logAttemptFailure(retryLogger, result, attempt, retryConfig.maxAttempts);
        const decision = decideRetry(result, attempt, retryConfig);

        if (decision.type === "stop") {
          logRetry(
            retryLogger,
            "retry_exhausted",
            {
              attempt,
              maxAttempts: retryConfig.maxAttempts,
              reason: decision.reason,
              ...errorFields(result.error),
            },
            result.error,
          );
          stream.push({ type: "error", error: result.error });
          return;
        }

        logRetry(retryLogger, "retry_scheduled", {
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: retryConfig.maxAttempts,
          delayMs: decision.delayMs,
          ...errorFields(result.error),
        });
        onRetry?.(attempt, decision.delayMs, result.error);
        if (result.outputState === "discardable_draft") {
          stream.push({
            type: "retry",
            attempt: attempt + 1,
            maxAttempts: retryConfig.maxAttempts,
            delayMs: decision.delayMs,
            error: result.error,
          });
        }

        await waitForRetryDelay(decision.delayMs, signal);
      }
    })().catch((err) => {
      const providerErr = toProviderError(err);
      logRetry(retryLogger, "retry_wrapper_failed", errorFields(providerErr), providerErr);
      stream.push({ type: "error", error: providerErr });
    });
    stream.setInnerWork(work);

    return stream;
  };
}
