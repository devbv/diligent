// @summary Wraps stream functions with exponential backoff retry logic

import { createLogger, type Logger } from "@diligent/logging";
import { EventStream } from "../event-stream";
import type { ProviderEvent, ProviderResult, StreamFunction } from "./types";
import { ProviderError, ProviderErrorType } from "./types";

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const defaultRetryLogger = createLogger({ scope: "llm:retry" });

function isVisibleProviderEvent(event: ProviderEvent): boolean {
  return (
    event.type !== "start" &&
    event.type !== "usage" &&
    event.type !== "retry" &&
    event.type !== "text_end" &&
    event.type !== "thinking_end"
  );
}

function toProviderError(err: unknown): ProviderError {
  return err instanceof ProviderError
    ? err
    : new ProviderError(err instanceof Error ? err.message : String(err), ProviderErrorType.Unknown, false);
}

function errorFields(error: ProviderError): Record<string, unknown> {
  return {
    errorType: error.errorType,
    retryable: error.isRetryable,
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

function formatProviderErrorForLog(error: ProviderError): string {
  const fields = [
    `name=${error.name}`,
    `message=${error.message}`,
    `code=${providerErrorCode(error) ?? "n/a"}`,
    `type=${error.errorType}`,
    `reason=${error.reason ?? "n/a"}`,
    `status=${error.statusCode ?? "n/a"}`,
    `retryable=${error.isRetryable}`,
  ];
  if (error.retryAfterMs !== undefined) fields.push(`retryAfterMs=${error.retryAfterMs}`);
  return fields.join(" ");
}

function logIfProviderError(logger: Logger, error: unknown, attempt: number, maxAttempts: number): void {
  if (!(error instanceof ProviderError)) return;
  logger.warn("provider_error", {
    message: `Provider error: [llm:provider-error] status=${error.statusCode ?? "n/a"} message=${error.message}`,
    error,
    fields: { attempt, maxAttempts, ...errorFields(error) },
  });
}

function logRetry(
  logger: Logger,
  level: "info" | "warn" | "error",
  event: string,
  message: string,
  fields: Record<string, unknown>,
  error?: ProviderError,
): void {
  logger[level](event, { message: `[llm:retry] ${message}`, fields, ...(error && { error }) });
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
  return (model, context, options) => {
    const retryLogger = logger.child({
      ...(options.sessionId !== undefined && { sessionId: options.sessionId }),
      fields: { provider: model.provider, model: model.id },
    });
    const signal = options.signal;
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );

    (async () => {
      for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
        if (signal?.aborted) {
          logRetry(retryLogger, "info", "retry_aborted", `aborted before attempt=${attempt}/${config.maxAttempts}`, {
            attempt,
            maxAttempts: config.maxAttempts,
          });
          stream.push({
            type: "error",
            error: new ProviderError("Aborted", ProviderErrorType.Unknown, false),
          });
          return;
        }

        let errorEvent: ProviderError | undefined;
        let hasSentDelta = false;
        let sawToolCallEnd = false;
        let inner: ReturnType<StreamFunction> | undefined;

        try {
          // Collect events from the inner stream
          inner = streamFn(model, context, options);

          for await (const event of inner) {
            if (event.type === "error") {
              // Capture the error, don't forward yet
              logIfProviderError(retryLogger, event.error, attempt, config.maxAttempts);
              errorEvent = toProviderError(event.error);
              logRetry(
                retryLogger,
                "warn",
                "stream_error",
                `stream error attempt=${attempt}/${config.maxAttempts} ${formatProviderErrorForLog(errorEvent)}`,
                { attempt, maxAttempts: config.maxAttempts, ...errorFields(errorEvent) },
                errorEvent,
              );
              break;
            }

            if (event.type === "done") {
              // Success — forward the done event and return
              if (attempt > 1) {
                logRetry(
                  retryLogger,
                  "info",
                  "retry_recovered",
                  `recovered on attempt=${attempt}/${config.maxAttempts}`,
                  { attempt, maxAttempts: config.maxAttempts },
                );
              }
              stream.push(event);
              return;
            }

            // Forward non-terminal events (text_delta, etc.)
            // Track whether any visible output has been sent — once user-visible
            // streaming starts, retry is unsafe because the consumer already
            // received partial output. Provider bookkeeping events like `start`
            // and `usage` do not make retry unsafe.
            if (event.type === "tool_call_end") sawToolCallEnd = true;
            if (isVisibleProviderEvent(event)) hasSentDelta = true;
            stream.push(event);
          }
        } catch (err) {
          logIfProviderError(retryLogger, err, attempt, config.maxAttempts);
          errorEvent = toProviderError(err);
          logRetry(
            retryLogger,
            "warn",
            "stream_exception",
            `stream exception attempt=${attempt}/${config.maxAttempts} ${formatProviderErrorForLog(errorEvent)}`,
            { attempt, maxAttempts: config.maxAttempts, ...errorFields(errorEvent) },
            errorEvent,
          );
        }

        // Consume the inner stream's rejected result to prevent unhandled rejection
        inner?.result().catch(() => {});

        // If no error captured from events, check if stream completed normally
        if (!errorEvent) {
          errorEvent = new ProviderError(
            "Provider stream ended without producing a terminal event",
            ProviderErrorType.Network,
            true,
          );
          logRetry(
            retryLogger,
            "warn",
            "stream_ended",
            `stream ended without terminal event attempt=${attempt}/${config.maxAttempts}`,
            { attempt, maxAttempts: config.maxAttempts, ...errorFields(errorEvent) },
            errorEvent,
          );
        }

        // We have an error — decide whether to retry. After visible streaming
        // starts, retry is allowed only while no complete tool call was emitted;
        // consumers receive a retry event so they can discard the visible draft.
        if (sawToolCallEnd || !errorEvent.isRetryable || attempt >= config.maxAttempts) {
          const reason = sawToolCallEnd
            ? "tool_call_already_completed"
            : !errorEvent.isRetryable
              ? "not_retryable"
              : "max_attempts_reached";
          logRetry(
            retryLogger,
            "error",
            "retry_exhausted",
            `giving up attempt=${attempt}/${config.maxAttempts} reason=${reason} ${formatProviderErrorForLog(errorEvent)}`,
            { attempt, maxAttempts: config.maxAttempts, reason, ...errorFields(errorEvent) },
            errorEvent,
          );
          stream.push({ type: "error", error: errorEvent });
          return;
        }

        // Calculate delay with exponential backoff
        const exponentialDelay = config.baseDelayMs * 2 ** (attempt - 1);
        const delayMs = Math.min(Math.max(exponentialDelay, errorEvent.retryAfterMs ?? 0), config.maxDelayMs);

        logRetry(
          retryLogger,
          "info",
          "retry_scheduled",
          `retrying nextAttempt=${attempt + 1}/${config.maxAttempts} delayMs=${delayMs} type=${errorEvent.errorType}`,
          {
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts: config.maxAttempts,
            delayMs,
            ...errorFields(errorEvent),
          },
        );
        onRetry?.(attempt, delayMs, errorEvent);
        if (hasSentDelta) {
          stream.push({
            type: "retry",
            attempt: attempt + 1,
            maxAttempts: config.maxAttempts,
            delayMs,
            error: errorEvent,
          });
        }

        // Wait with abort support
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          if (signal) {
            const onAbort = () => {
              clearTimeout(timer);
              resolve();
            };
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      }
    })().catch((err) => {
      const providerErr = toProviderError(err);
      logRetry(
        retryLogger,
        "error",
        "wrapper_exception",
        `wrapper exception ${formatProviderErrorForLog(providerErr)}`,
        errorFields(providerErr),
        providerErr,
      );
      stream.push({ type: "error", error: providerErr });
    });

    return stream;
  };
}
