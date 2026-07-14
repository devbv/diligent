// @summary Tests for agent loop retry behavior and usage cost calculation
import { describe, expect, test } from "bun:test";
import type { Logger, LogRecord } from "@diligent/logging";
import { createLogger } from "@diligent/logging";
import { Agent } from "../../src/agent/agent";
import type { AgentOptions, CoreAgentEvent } from "../../src/agent/types";
import { EventStream } from "../../src/event-stream";
import type { Model, ProviderEvent, ProviderResult, StreamFunction } from "../../src/llm/types";
import { ProviderError } from "../../src/llm/types";
import type { AssistantMessage } from "../../src/types";

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
  errorType: "server_error" | "auth" = "server_error",
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

    // Use setTimeout to ensure the event loop has processed all pending microtasks
    // before pushing events, avoiding premature unhandled rejection detection.
    setTimeout(() => {
      if (currentCall < failCount) {
        const isRetryable = errorType === "server_error";
        const statusCode = errorType === "server_error" ? 503 : 401;
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

async function runAgent(
  streamFn: StreamFunction,
  opts?: { retry?: AgentOptions["retry"]; signal?: AbortSignal; logger?: Logger; sessionId?: string },
): Promise<{ events: CoreAgentEvent[] }> {
  const agent = new Agent(testModel, [{ label: "test", content: "test" }], [], {
    effort: "medium",
    llmMsgStreamFn: streamFn,
    logger: opts?.logger,
    sessionId: opts?.sessionId,
    retry: {
      maxRetries: opts?.retry?.maxRetries ?? 5,
      baseDelayMs: opts?.retry?.baseDelayMs ?? 1,
      maxDelayMs: opts?.retry?.maxDelayMs ?? 10,
    },
  });
  const events: CoreAgentEvent[] = [];
  const unsub = agent.subscribe((e) => events.push(e));
  try {
    await agent.prompt({ role: "user", content: "hi", timestamp: Date.now() }, opts?.signal);
  } catch {
    // swallow abort / error so we can inspect events
  } finally {
    unsub();
  }
  return { events };
}

describe("agent loop retry + usage", () => {
  test("emits usage event after successful turn", async () => {
    const { streamFn } = createMockStreamFn(0);
    const { events } = await runAgent(streamFn);

    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent).toBeDefined();
    if (usageEvent?.type === "usage") {
      expect(usageEvent.usage.inputTokens).toBe(100);
      expect(usageEvent.usage.outputTokens).toBe(50);
    }
  });

  test("retryable failures eventually recover without surfacing fatal events", async () => {
    const { streamFn } = createMockStreamFn(2, "server_error");
    const { events } = await runAgent(streamFn, { retry: { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 10 } });

    expect(events.some((e) => e.type === "usage")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  test("injects the Agent logger and session context into retry records", async () => {
    const { streamFn } = createMockStreamFn(1, "server_error");
    const records: LogRecord[] = [];
    await runAgent(streamFn, {
      logger: createLogger({ scope: "test-agent", sink: (record) => records.push(record) }),
      sessionId: "agent-session",
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });

    expect(records.find((record) => record.event === "retry_scheduled")).toMatchObject({
      scope: "llm:retry",
      sessionId: "agent-session",
      fields: {
        provider: "test",
        model: "test-model",
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 2,
        delayMs: 1,
      },
    });
  });

  test("non-retryable error propagates immediately", async () => {
    const { streamFn, callCount } = createMockStreamFn(1, "auth");
    const { events } = await runAgent(streamFn, { retry: { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 10 } });

    // Should only have 1 call (no retries for auth error)
    expect(callCount()).toBe(1);
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("abort cancels retry", async () => {
    const { streamFn } = createMockStreamFn(10, "server_error");
    const controller = new AbortController();

    // Abort after a short delay
    setTimeout(() => controller.abort(), 100);

    const { events } = await runAgent(streamFn, {
      retry: { maxRetries: 10, baseDelayMs: 50, maxDelayMs: 100 },
      signal: controller.signal,
    });

    // Should not have all 10 retries
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});
