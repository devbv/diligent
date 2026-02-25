import { EventStream } from "../event-stream";
import type { ProviderEvent, ProviderResult, StreamFunction } from "./types";
import { ProviderError } from "./types";

export interface RetryConfig {
  maxAttempts: number; // default: 5
  baseDelayMs: number; // default: 1000 (1s)
  maxDelayMs: number; // default: 30_000 (30s)
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, error: ProviderError) => void;
}

/**
 * Wraps a StreamFunction with exponential backoff retry.
 * Only retries on retryable errors. Respects retry-after headers. (D010)
 */
export function withRetry(streamFn: StreamFunction, config: RetryConfig): StreamFunction {
  return (model, context, options) => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );

    (async () => {
      for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
        if (config.signal?.aborted) {
          stream.push({
            type: "error",
            error: new ProviderError("Aborted", "unknown", false),
          });
          return;
        }

        // Collect events from the inner stream
        const inner = streamFn(model, context, options);
        let errorEvent: ProviderError | undefined;

        for await (const event of inner) {
          if (event.type === "error") {
            // Capture the error, don't forward yet
            const err = event.error;
            errorEvent =
              err instanceof ProviderError
                ? err
                : new ProviderError(err instanceof Error ? err.message : String(err), "unknown", false);
            break;
          }

          if (event.type === "done") {
            // Success — forward the done event and return
            stream.push(event);
            return;
          }

          // Forward non-terminal events (text_delta, etc.)
          stream.push(event);
        }

        // Consume the inner stream's rejected result to prevent unhandled rejection
        inner.result().catch(() => {});

        // If no error captured from events, check if stream completed normally
        if (!errorEvent) {
          // Stream ended without error or done event — shouldn't happen but handle it
          return;
        }

        // We have an error — decide whether to retry
        if (!errorEvent.isRetryable || attempt >= config.maxAttempts) {
          stream.push({ type: "error", error: errorEvent });
          return;
        }

        // Calculate delay with exponential backoff
        const exponentialDelay = config.baseDelayMs * 2 ** (attempt - 1);
        const delayMs = Math.min(Math.max(exponentialDelay, errorEvent.retryAfterMs ?? 0), config.maxDelayMs);

        config.onRetry?.(attempt, delayMs, errorEvent);

        // Wait with abort support
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          if (config.signal) {
            const onAbort = () => {
              clearTimeout(timer);
              resolve();
            };
            config.signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      }
    })();

    return stream;
  };
}
