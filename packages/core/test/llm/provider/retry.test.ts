// @summary Tests for provider stream retry wrapper behavior
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Logger } from "@diligent/logging";
import { EventStream } from "../../../src/event-stream";
import { withRetry } from "../../../src/llm/retry";
import type {
  Model,
  ProviderEvent,
  ProviderResult,
  StreamContext,
  StreamFunction,
  StreamOptions,
} from "../../../src/llm/types";
import { ProviderError } from "../../../src/llm/types";
import type { AssistantMessage } from "../../../src/types";

const testModel: Model = {
  modelId: "test-model",
  provider: "anthropic",
  contextWindow: 100000,
  maxOutputTokens: 4096,
  supportsThinking: false,
};

function makeAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    model: { provider: "anthropic", modelId: "test-model" },
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

/** Creates a StreamFunction that fails N times then succeeds */
function createFailingStreamFn(failures: ProviderError[]): { streamFn: StreamFunction; callCount: () => number } {
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
  systemPrompt: [{ label: "test", content: "test" }],
  messages: [],
  tools: [],
};

const testOptions: StreamOptions = {};

afterEach(() => {
  console.warn = originalConsoleWarn;
  console.info = originalConsoleInfo;
  console.error = originalConsoleError;
  mock.restore();
});

const originalConsoleWarn = console.warn;
const originalConsoleInfo = console.info;
const originalConsoleError = console.error;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectRetryLogContext(line: string, sessionId: string): void {
  const pattern = new RegExp(
    `^\\[llm:retry\\] timestamp=\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z sessionId=${escapeRegex(sessionId)} `,
  );
  expect(line).toMatch(pattern);
}

type LoggedCall = {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  message: string;
  fields?: Record<string, unknown>;
};

function recordingLogger(
  calls: LoggedCall[],
  context: { sessionId?: string; fields?: Readonly<Record<string, unknown>> } = {},
): Logger {
  const write =
    (level: LoggedCall["level"]) =>
    (event: string, input: string | { message?: string; fields?: Readonly<Record<string, unknown>> }) => {
      calls.push({
        level,
        event,
        message: typeof input === "string" ? input : (input.message ?? event),
        fields: {
          ...(context.sessionId !== undefined && { sessionId: context.sessionId }),
          ...context.fields,
          ...(typeof input === "string" ? {} : input.fields),
        },
      });
    };
  return {
    child: (childContext) => {
      const child = childContext ?? {};
      return recordingLogger(calls, {
        sessionId: child.sessionId ?? context.sessionId,
        fields: { ...context.fields, ...child.fields },
      });
    },
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  } as Logger;
}

describe("withRetry", () => {
  test("tracks the wrapper worker until the aborted inner stream cleanup settles", async () => {
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const controller = new AbortController();
    const streamFn: StreamFunction = () => {
      const inner = new EventStream<ProviderEvent, ProviderResult>(
        (event) => event.type === "done" || event.type === "error",
        (event) => {
          if (event.type === "done") return { message: event.message };
          throw (event as { type: "error"; error: Error }).error;
        },
      );
      inner.attachSignal(controller.signal);
      inner.setInnerWork(cleanup);
      inner.result().catch(() => {});
      return inner;
    };
    const stream = withRetry(streamFn, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 })(testModel, testContext, {
      signal: controller.signal,
    });
    controller.abort();

    let settled = false;
    const waiting = stream.waitForInnerWork().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseCleanup();
    await waiting;
    await stream.result().catch(() => {});
    expect(settled).toBe(true);
  });

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
      new ProviderError("server unavailable", "server_error", true, undefined, 503),
      new ProviderError("overloaded", "server_error", true, undefined, 529),
    ];
    const { streamFn, callCount } = createFailingStreamFn(failures);

    const retryCallbacks: Array<{ attempt: number; delayMs: number }> = [];
    const retried = withRetry(streamFn, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 100 }, (attempt, delayMs) => {
      retryCallbacks.push({ attempt, delayMs });
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

  test("logs provider error status and message before retry handling", async () => {
    const failures = [new ProviderError("server unavailable", "server_error", true, undefined, 503)];
    const { streamFn } = createFailingStreamFn(failures);
    const logs: string[] = [];
    console.warn = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    const retried = withRetry(streamFn, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 });

    const stream = retried(testModel, testContext, testOptions);
    for await (const _event of stream) {
      /* consume */
    }
    await stream.result().catch(() => {});

    expect(logs.some((line) => line.includes("[llm:provider-error] status=503 message=server unavailable"))).toBe(true);
  });

  test("includes timestamp and sessionId in retry logs when sessionId is present", async () => {
    const failures = [new ProviderError("server unavailable", "server_error", true, undefined, 503)];
    const { streamFn } = createFailingStreamFn(failures);
    const logs: string[] = [];
    console.warn = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    console.info = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    const retried = withRetry(streamFn, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 });

    const stream = retried(testModel, testContext, { ...testOptions, sessionId: "session-123" });
    for await (const _event of stream) {
      /* consume */
    }
    await stream.result().catch(() => {});

    const retryLogs = logs.filter((line) => line.startsWith("[llm:retry]"));
    expect(retryLogs.length).toBeGreaterThan(0);
    expectRetryLogContext(retryLogs[0], "session-123");
    const streamErrorLog = retryLogs.find((line) => line.includes("stream error attempt=1/2"));
    expect(streamErrorLog).toBeDefined();
    expect((streamErrorLog?.match(/timestamp=/g) ?? []).length).toBe(1);
    expect(streamErrorLog).not.toContain("requestStartedAt=");
    expect(retryLogs.some((line) => line.includes("retrying nextAttempt=2/2 delayMs=1 type=server_error"))).toBe(true);
    expect(retryLogs.some((line) => line.includes("recovered on attempt=2/2"))).toBe(true);
  });

  test("emits stable structured retry records with session, retry, and model metadata", async () => {
    const failures = [new ProviderError("server unavailable", "server_error", true, 2, 503)];
    const { streamFn } = createFailingStreamFn(failures);
    const calls: LoggedCall[] = [];
    const retried = withRetry(
      streamFn,
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 },
      undefined,
      recordingLogger(calls),
    );

    const stream = retried(testModel, testContext, { ...testOptions, sessionId: "session-structured" });
    for await (const _event of stream) {
      /* consume */
    }
    await stream.result().catch(() => {});

    expect(calls.map((call) => call.event)).toEqual([
      "provider_error",
      "stream_error",
      "retry_scheduled",
      "retry_recovered",
    ]);
    expect(calls.find((call) => call.event === "stream_error")?.fields).toMatchObject({
      sessionId: "session-structured",
      attempt: 1,
      maxAttempts: 2,
      errorType: "server_error",
      retryAfterMs: 2,
      statusCode: 503,
      provider: "anthropic",
      model: "test-model",
    });
    expect(calls.find((call) => call.event === "retry_scheduled")?.fields).toMatchObject({
      sessionId: "session-structured",
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 2,
      delayMs: 2,
      errorType: "server_error",
      provider: "anthropic",
      model: "test-model",
    });
    for (const call of calls) {
      expect(call.fields).not.toHaveProperty("timestamp");
      expect(call.message).not.toContain("timestamp=");
      expect(call.message).not.toContain("requestStartedAt=");
    }
  });

  test("includes timestamp and n/a sessionId in retry logs when sessionId is missing", async () => {
    const streamFn: StreamFunction = () => {
      throw new ProviderError("fatal", "unknown", false, undefined, 500);
    };
    const logs: string[] = [];
    console.warn = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    const retried = withRetry(streamFn, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 10 });

    const stream = retried(testModel, testContext, testOptions);
    for await (const _event of stream) {
      /* consume */
    }
    await stream.result().catch(() => {});

    const retryLogs = logs.filter((line) => line.startsWith("[llm:retry]"));
    expect(retryLogs.length).toBeGreaterThan(0);
    expectRetryLogContext(retryLogs[0], "n/a");
    expect(retryLogs.some((line) => line.includes("stream exception attempt=1/1"))).toBe(true);
    expect(retryLogs.some((line) => line.includes("giving up attempt=1/1 reason=not_retryable"))).toBe(true);
  });

  test("stops on non-retryable error", async () => {
    const failures = [new ProviderError("unauthorized", "auth", false, undefined, 401)];
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
      new ProviderError("server unavailable", "server_error", true, undefined, 503),
      new ProviderError("server unavailable", "server_error", true, undefined, 503),
      new ProviderError("server unavailable", "server_error", true, undefined, 503),
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
      new ProviderError("server unavailable", "server_error", true, 50, 503), // 50ms retry-after
    ];
    const { streamFn } = createFailingStreamFn(failures);

    const retryDelays: number[] = [];
    const retried = withRetry(streamFn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1000 }, (_attempt, delayMs) => {
      retryDelays.push(delayMs);
    });

    const stream = retried(testModel, testContext, testOptions);
    for await (const _event of stream) {
      /* consume */
    }
    await stream.result().catch(() => {});

    // retry-after (50ms) > baseDelay * 2^0 (1ms), so should use 50ms
    expect(retryDelays[0]).toBe(50);
  });

  test("abort cancels retry", async () => {
    const failures = [
      new ProviderError("server unavailable", "server_error", true, undefined, 503),
      new ProviderError("server unavailable", "server_error", true, undefined, 503),
    ];
    const { streamFn, callCount } = createFailingStreamFn(failures);
    const controller = new AbortController();

    const retried = withRetry(streamFn, { maxAttempts: 5, baseDelayMs: 50, maxDelayMs: 100 }, () => {
      controller.abort();
    });

    const stream = retried(testModel, testContext, { ...testOptions, signal: controller.signal });
    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.result().catch(() => {});

    // Should have stopped early
    expect(callCount()).toBeLessThanOrEqual(2);
  });

  test("abort requested by the retry callback skips the pending delay", async () => {
    const failures = [new ProviderError("server unavailable", "server_error", true, undefined, 503)];
    const { streamFn } = createFailingStreamFn(failures);
    const controller = new AbortController();
    const retried = withRetry(streamFn, { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 1_000 }, () => {
      controller.abort();
    });

    const startedAt = performance.now();
    const stream = retried(testModel, testContext, { ...testOptions, signal: controller.signal });
    for await (const _event of stream) {
      /* consume */
    }
    await stream.result().catch(() => {});

    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test("retries after visible streaming by emitting retry discard signal", async () => {
    // Simulates a retryable error that occurs mid-stream, after a text_delta was already emitted.
    let callCount = 0;
    const streamFn: StreamFunction = (_model, _context, _options) => {
      const stream = new EventStream<ProviderEvent, ProviderResult>(
        (event) => event.type === "done" || event.type === "error",
        (event) => {
          if (event.type === "done") return { message: event.message };
          throw (event as { type: "error"; error: Error }).error;
        },
      );

      const currentCall = callCount++;
      queueMicrotask(() => {
        if (currentCall === 0) {
          stream.push({ type: "text_delta", delta: "partial" });
          stream.push({
            type: "error",
            error: new ProviderError("overloaded mid-stream", "server_error", true, undefined, 529),
          });
          return;
        }
        stream.push({ type: "text_delta", delta: "recovered" });
        stream.push({ type: "done", stopReason: "end_turn", message: makeAssistantMessage() });
      });

      return stream;
    };

    const retried = withRetry(streamFn, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10 });

    const stream = retried(testModel, testContext, testOptions);
    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.result().catch(() => {});

    expect(callCount).toBe(2);
    expect(events.find((e) => e.type === "retry")).toMatchObject({
      type: "retry",
      attempt: 2,
      maxAttempts: 5,
    });
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  test("does not retry after a tool call completed", async () => {
    let callCount = 0;
    const streamFn: StreamFunction = (_model, _context, _options) => {
      const stream = new EventStream<ProviderEvent, ProviderResult>(
        (event) => event.type === "done" || event.type === "error",
        (event) => {
          if (event.type === "done") return { message: event.message };
          throw (event as { type: "error"; error: Error }).error;
        },
      );

      callCount++;
      queueMicrotask(() => {
        stream.push({ type: "tool_call_start", id: "tool-1", name: "read" });
        stream.push({ type: "tool_call_end", id: "tool-1", name: "read", input: {} });
        stream.push({
          type: "error",
          error: new ProviderError("server error after tool", "server_error", true, undefined, 503),
        });
      });

      return stream;
    };

    const retried = withRetry(streamFn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 });

    const stream = retried(testModel, testContext, testOptions);
    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.result().catch(() => {});

    expect(callCount).toBe(1);
    expect(events.find((e) => e.type === "retry")).toBeUndefined();
    expect(events.find((e) => e.type === "error")).toBeDefined();
  });

  test("retries after start event when no visible output was emitted", async () => {
    let callCount = 0;
    const streamFn: StreamFunction = (_model, _context, _options) => {
      const stream = new EventStream<ProviderEvent, ProviderResult>(
        (event) => event.type === "done" || event.type === "error",
        (event) => {
          if (event.type === "done") return { message: event.message };
          throw (event as { type: "error"; error: Error }).error;
        },
      );

      const currentCall = callCount++;
      queueMicrotask(() => {
        if (currentCall === 0) {
          stream.push({ type: "start" });
          stream.push({
            type: "error",
            error: new ProviderError("server error", "server_error", true, undefined, 503),
          });
          return;
        }
        stream.push({ type: "start" });
        stream.push({ type: "done", stopReason: "end_turn", message: makeAssistantMessage() });
      });

      return stream;
    };

    const retried = withRetry(streamFn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 });

    const stream = retried(testModel, testContext, testOptions);
    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.result().catch(() => {});

    expect(callCount).toBe(2);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  test("retries retryable ProviderError thrown while creating the stream", async () => {
    let callCount = 0;
    const streamFn: StreamFunction = (_model, _context, _options) => {
      const currentCall = callCount++;
      if (currentCall === 0) {
        throw new ProviderError("server unavailable", "server_error", true, undefined, 503);
      }

      const stream = new EventStream<ProviderEvent, ProviderResult>(
        (event) => event.type === "done" || event.type === "error",
        (event) => {
          if (event.type === "done") return { message: event.message };
          throw (event as { type: "error"; error: Error }).error;
        },
      );
      queueMicrotask(() => {
        stream.push({ type: "done", stopReason: "end_turn", message: makeAssistantMessage() });
      });
      return stream;
    };

    const retried = withRetry(streamFn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 });

    const stream = retried(testModel, testContext, testOptions);
    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.result().catch(() => {});

    expect(callCount).toBe(2);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("exponential backoff increases delay", async () => {
    const failures = [
      new ProviderError("overloaded", "server_error", true, undefined, 529),
      new ProviderError("overloaded", "server_error", true, undefined, 529),
      new ProviderError("overloaded", "server_error", true, undefined, 529),
    ];
    const { streamFn } = createFailingStreamFn(failures);

    const retryDelays: number[] = [];
    const retried = withRetry(streamFn, { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 1000 }, (_attempt, delayMs) => {
      retryDelays.push(delayMs);
    });

    const stream = retried(testModel, testContext, testOptions);
    for await (const _event of stream) {
      /* consume */
    }
    await stream.result().catch(() => {});

    // Delays should increase: 10, 20, 40
    expect(retryDelays[0]).toBe(10);
    expect(retryDelays[1]).toBe(20);
    expect(retryDelays[2]).toBe(40);
  });
});
