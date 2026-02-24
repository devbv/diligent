import { describe, test, expect } from "bun:test";
import { EventStream } from "../src/event-stream";
import { ProviderError } from "../src/provider/types";
import type { StreamFunction, ProviderEvent, ProviderResult, Model, StreamContext, StreamOptions } from "../src/provider/types";
import type { AssistantMessage } from "../src/types";
import { withRetry } from "../src/provider/retry";

const testModel: Model = {
  id: "test-model",
  provider: "test",
  contextWindow: 100000,
  maxOutputTokens: 4096,
};

function makeAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

/** Creates a StreamFunction that fails N times then succeeds */
function createFailingStreamFn(
  failures: ProviderError[],
): { streamFn: StreamFunction; callCount: () => number } {
  let calls = 0;

  const streamFn: StreamFunction = (_model, _context, _options) => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );

    const currentCall = calls++;

    queueMicrotask(() => {
      if (currentCall < failures.length) {
        stream.push({ type: "error", error: failures[currentCall] });
      } else {
        const msg = makeAssistantMessage();
        stream.push({ type: "start" });
        stream.push({ type: "text_delta", delta: "hello" });
        stream.push({ type: "done", stopReason: "end_turn", message: msg });
      }
    });

    return stream;
  };

  return { streamFn, callCount: () => calls };
}

const testContext: StreamContext = {
  systemPrompt: "test",
  messages: [],
  tools: [],
};

const testOptions: StreamOptions = {
  apiKey: "test-key",
};

describe("withRetry", () => {
  test("succeeds on first attempt without retrying", async () => {
    const { streamFn, callCount } = createFailingStreamFn([]);
    const retried = withRetry(streamFn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    const stream = retried(testModel, testContext, testOptions);
    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    // Consume result to prevent unhandled rejection
    await stream.result().catch(() => {});

    expect(callCount()).toBe(1);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  test("retries on retryable errors and eventually succeeds", async () => {
    const failures = [
      new ProviderError("rate limited", "rate_limit", true, undefined, 429),
      new ProviderError("overloaded", "overloaded", true, undefined, 529),
    ];
    const { streamFn, callCount } = createFailingStreamFn(failures);

    const retryCallbacks: Array<{ attempt: number; delayMs: number }> = [];
    const retried = withRetry(streamFn, {
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 100,
      onRetry: (attempt, delayMs) => {
        retryCallbacks.push({ attempt, delayMs });
      },
    });

    const stream = retried(testModel, testContext, testOptions);
    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.result().catch(() => {});

    expect(callCount()).toBe(3); // 2 failures + 1 success
    expect(retryCallbacks.length).toBe(2);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  test("stops on non-retryable error", async () => {
    const failures = [
      new ProviderError("unauthorized", "auth", false, undefined, 401),
    ];
    const { streamFn, callCount } = createFailingStreamFn(failures);

    const retried = withRetry(streamFn, {
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    const stream = retried(testModel, testContext, testOptions);
    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.result().catch(() => {});

    expect(callCount()).toBe(1); // Only 1 attempt, no retry
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
  });

  test("stops after max attempts exceeded", async () => {
    const failures = [
      new ProviderError("rate limited", "rate_limit", true, undefined, 429),
      new ProviderError("rate limited", "rate_limit", true, undefined, 429),
      new ProviderError("rate limited", "rate_limit", true, undefined, 429),
    ];
    const { streamFn, callCount } = createFailingStreamFn(failures);

    const retried = withRetry(streamFn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    const stream = retried(testModel, testContext, testOptions);
    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.result().catch(() => {});

    expect(callCount()).toBe(3);
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
  });

  test("respects retry-after delay", async () => {
    const failures = [
      new ProviderError("rate limited", "rate_limit", true, 50, 429), // 50ms retry-after
    ];
    const { streamFn } = createFailingStreamFn(failures);

    const retryDelays: number[] = [];
    const retried = withRetry(streamFn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1000,
      onRetry: (_attempt, delayMs) => {
        retryDelays.push(delayMs);
      },
    });

    const stream = retried(testModel, testContext, testOptions);
    for await (const _event of stream) { /* consume */ }
    await stream.result().catch(() => {});

    // retry-after (50ms) > baseDelay * 2^0 (1ms), so should use 50ms
    expect(retryDelays[0]).toBe(50);
  });

  test("abort cancels retry", async () => {
    const failures = [
      new ProviderError("rate limited", "rate_limit", true, undefined, 429),
      new ProviderError("rate limited", "rate_limit", true, undefined, 429),
    ];
    const { streamFn, callCount } = createFailingStreamFn(failures);
    const controller = new AbortController();

    const retried = withRetry(streamFn, {
      maxAttempts: 5,
      baseDelayMs: 50,
      maxDelayMs: 100,
      signal: controller.signal,
      onRetry: () => {
        // Abort after first retry attempt starts
        controller.abort();
      },
    });

    const stream = retried(testModel, testContext, testOptions);
    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.result().catch(() => {});

    // Should have stopped early
    expect(callCount()).toBeLessThanOrEqual(2);
  });

  test("exponential backoff increases delay", async () => {
    const failures = [
      new ProviderError("overloaded", "overloaded", true, undefined, 529),
      new ProviderError("overloaded", "overloaded", true, undefined, 529),
      new ProviderError("overloaded", "overloaded", true, undefined, 529),
    ];
    const { streamFn } = createFailingStreamFn(failures);

    const retryDelays: number[] = [];
    const retried = withRetry(streamFn, {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      onRetry: (_attempt, delayMs) => {
        retryDelays.push(delayMs);
      },
    });

    const stream = retried(testModel, testContext, testOptions);
    for await (const _event of stream) { /* consume */ }
    await stream.result().catch(() => {});

    // Delays should increase: 10, 20, 40
    expect(retryDelays[0]).toBe(10);
    expect(retryDelays[1]).toBe(20);
    expect(retryDelays[2]).toBe(40);
  });
});
