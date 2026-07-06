// @summary Wraps stream functions with exponential backoff retry logic

import { formatSerializableErrorForLog, toSerializableError } from "../agent/util/errors";
import { EventStream } from "../event-stream";
import type { ProviderEvent, ProviderResult, StreamFunction } from "./types";
import { ProviderError } from "./types";

export interface RetryConfig {
  maxAttempts: number; // default: 5
  baseDelayMs: number; // default: 1000 (1s)
  maxDelayMs: number; // default: 30_000 (30s)
}

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
    : new ProviderError(err instanceof Error ? err.message : String(err), "unknown", false);
}

function logProviderError(error: ProviderError): void {
  console.log(`[llm:provider-error] status=${error.statusCode ?? "n/a"} message=${error.message}`);
}

function logIfProviderError(error: unknown): void {
  if (error instanceof ProviderError) logProviderError(error);
}

/**
 * Wraps a StreamFunction with exponential backoff retry.
 * Only retries on retryable errors. Respects retry-after headers. (D010)
 */
export function withRetry(
  streamFn: StreamFunction,
  config: RetryConfig,
  onRetry?: (attempt: number, delayMs: number, error: ProviderError) => void,
): StreamFunction {
  return (model, context, options) => {
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
          console.log(`[llm:retry] aborted before attempt=${attempt}/${config.maxAttempts}`);
          stream.push({
            type: "error",
            error: new ProviderError("Aborted", "unknown", false),
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
              logIfProviderError(event.error);
              errorEvent = toProviderError(event.error);
              console.log(
                `[llm:retry] stream error attempt=${attempt}/${config.maxAttempts} ${formatSerializableErrorForLog(toSerializableError(errorEvent))}`,
              );
              break;
            }

            if (event.type === "done") {
              // Success — forward the done event and return
              if (attempt > 1) {
                console.log(`[llm:retry] recovered on attempt=${attempt}/${config.maxAttempts}`);
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
          logIfProviderError(err);
          errorEvent = toProviderError(err);
          console.log(
            `[llm:retry] stream exception attempt=${attempt}/${config.maxAttempts} ${formatSerializableErrorForLog(toSerializableError(errorEvent))}`,
          );
        }

        // Consume the inner stream's rejected result to prevent unhandled rejection
        inner?.result().catch(() => {});

        // If no error captured from events, check if stream completed normally
        if (!errorEvent) {
          console.log(`[llm:retry] stream ended without terminal event attempt=${attempt}/${config.maxAttempts}`);
          errorEvent = new ProviderError("Provider stream ended without producing a terminal event", "network", true);
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
          console.log(
            `[llm:retry] giving up attempt=${attempt}/${config.maxAttempts} reason=${reason} ${formatSerializableErrorForLog(toSerializableError(errorEvent))}`,
          );
          stream.push({ type: "error", error: errorEvent });
          return;
        }

        // Calculate delay with exponential backoff
        const exponentialDelay = config.baseDelayMs * 2 ** (attempt - 1);
        const delayMs = Math.min(Math.max(exponentialDelay, errorEvent.retryAfterMs ?? 0), config.maxDelayMs);

        console.log(
          `[llm:retry] retrying nextAttempt=${attempt + 1}/${config.maxAttempts} delayMs=${delayMs} type=${errorEvent.errorType}`,
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
      console.log(`[llm:retry] wrapper exception ${formatSerializableErrorForLog(toSerializableError(providerErr))}`);
      stream.push({ type: "error", error: providerErr });
    });

    return stream;
  };
}
