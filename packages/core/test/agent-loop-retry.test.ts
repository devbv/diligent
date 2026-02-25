import { describe, expect, test } from "bun:test";
import { agentLoop } from "../src/agent/loop";
import type { AgentEvent } from "../src/agent/types";
import { EventStream } from "../src/event-stream";
import type { Model, ProviderEvent, ProviderResult, StreamFunction } from "../src/provider/types";
import { ProviderError } from "../src/provider/types";
import type { AssistantMessage } from "../src/types";

const testModel: Model = {
  id: "test-model",
  provider: "test",
  contextWindow: 100000,
  maxOutputTokens: 4096,
  inputCostPer1M: 3.0,
  outputCostPer1M: 15.0,
};

function makeAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    model: "test-model",
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

function createMockStreamFn(
  failCount: number = 0,
  errorType: "rate_limit" | "auth" = "rate_limit",
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

    // Use queueMicrotask for more predictable async behavior
    queueMicrotask(() => {
      if (currentCall < failCount) {
        const isRetryable = errorType === "rate_limit";
        const statusCode = errorType === "rate_limit" ? 429 : 401;
        stream.push({
          type: "error",
          error: new ProviderError(`Error ${errorType}`, errorType, isRetryable, undefined, statusCode),
        });
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

describe("agent loop retry + usage", () => {
  test("emits usage event after successful turn", async () => {
    const { streamFn } = createMockStreamFn(0);

    const stream = agentLoop([{ role: "user", content: "hi", timestamp: Date.now() }], {
      model: testModel,
      systemPrompt: "test",
      tools: [],
      streamFunction: streamFn,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
    });

    const events: AgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent).toBeDefined();
    if (usageEvent?.type === "usage") {
      expect(usageEvent.usage.inputTokens).toBe(100);
      expect(usageEvent.usage.outputTokens).toBe(50);
      // Cost = (100/1M * 3.0) + (50/1M * 15.0) = 0.0003 + 0.00075 = 0.00105
      expect(usageEvent.cost).toBeCloseTo(0.00105, 5);
    }
  });

  test("emits status_change during retry", async () => {
    const { streamFn } = createMockStreamFn(2, "rate_limit");

    const stream = agentLoop([{ role: "user", content: "hi", timestamp: Date.now() }], {
      model: testModel,
      systemPrompt: "test",
      tools: [],
      streamFunction: streamFn,
      maxRetries: 5,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
    });

    const events: AgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const statusEvents = events.filter((e) => e.type === "status_change");
    expect(statusEvents.length).toBe(2);
    if (statusEvents[0]?.type === "status_change") {
      expect(statusEvents[0].status).toBe("retry");
      expect(statusEvents[0].retry?.attempt).toBe(1);
    }
  });

  test("non-retryable error propagates immediately", async () => {
    const { streamFn, callCount } = createMockStreamFn(1, "auth");

    const stream = agentLoop([{ role: "user", content: "hi", timestamp: Date.now() }], {
      model: testModel,
      systemPrompt: "test",
      tools: [],
      streamFunction: streamFn,
      maxRetries: 5,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
    });

    const events: AgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Should only have 1 call (no retries for auth error)
    expect(callCount()).toBe(1);
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("abort cancels retry", async () => {
    const { streamFn } = createMockStreamFn(10, "rate_limit");
    const controller = new AbortController();

    const stream = agentLoop([{ role: "user", content: "hi", timestamp: Date.now() }], {
      model: testModel,
      systemPrompt: "test",
      tools: [],
      streamFunction: streamFn,
      maxRetries: 10,
      retryBaseDelayMs: 50,
      retryMaxDelayMs: 100,
      signal: controller.signal,
    });

    // Abort after a short delay
    setTimeout(() => controller.abort(), 100);

    const events: AgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Should not have all 10 retries
    const statusEvents = events.filter((e) => e.type === "status_change");
    expect(statusEvents.length).toBeLessThan(10);
  });
});
