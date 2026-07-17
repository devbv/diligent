// @summary Tests for ChatGPT WebSocket lifecycle and scoped session behavior
import { afterEach, describe, expect, test } from "bun:test";
import { resolveModel } from "../../../../src/llm/models";
import { createChatGPTStream } from "../../../../src/llm/provider/chatgpt";
import { withRetry } from "../../../../src/llm/retry";
import { createStreamTurnScope } from "../../../../src/llm/turn-scope";
import type { ProviderEvent, StreamContext } from "../../../../src/llm/types";
import {
  chatGPTSuccessResponse,
  collectEvents,
  collectScopedChatGPTEvents,
  completeWebSocketResponse,
  createWebSocketHarness,
  restoreChatGPTStreamTestState,
  TEST_CONTEXT,
  testTokens,
} from "../../../helpers/chatgpt-stream";

afterEach(restoreChatGPTStreamTestState);

describe("ChatGPT WebSocket session", () => {
  test("can explicitly use WebSocket + Lite for ChatGPT GPT-5.6", async () => {
    const harness = createWebSocketHarness((_body, socket) => completeWebSocketResponse(socket));
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
      }),
    );

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(harness.requests[0]?.url).toBe("wss://chatgpt.com/backend-api/codex/responses");
  });

  test("reuses one WebSocket for sequential scoped requests and closes it with the scope", async () => {
    const harness = createWebSocketHarness((_body, socket) => completeWebSocketResponse(socket));
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });
    const scope = createStreamTurnScope();
    const model = resolveModel("chatgpt-5.6-luna");

    await collectEvents(
      chatgptStream(model, TEST_CONTEXT, {
        effort: "medium",
        turnScope: scope,
      }),
    );
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.socket.closed).toBe(false);
    await collectEvents(
      chatgptStream(model, TEST_CONTEXT, {
        effort: "medium",
        turnScope: scope,
      }),
    );

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.socket.sent).toHaveLength(2);
    await scope.dispose();
    expect(harness.requests[0]?.socket.closed).toBe(true);
  });

  test("scoped path processes a delayed terminal WebSocket message before close", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      const payload = JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      const delayedBlob = new Blob([payload]);
      Object.defineProperty(delayedBlob, "text", {
        value: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return payload;
        },
      });

      queueMicrotask(() => {
        socket.emitRaw(delayedBlob);
        socket.emitClose(1000, "normal closure");
      });
    });
    const events = await collectScopedChatGPTEvents(
      createChatGPTStream(() => testTokens(), {
        useWebSocketForGpt56: true,
        webSocketFactory: harness.factory,
      }),
    );

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("scoped path times out when a WebSocket never opens", async () => {
    const harness = createWebSocketHarness(undefined, { autoOpen: false });
    const controller = new AbortController();
    const scope = createStreamTurnScope();
    const stream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
      webSocketIdleTimeoutMs: 1,
    })(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
      effort: "medium",
      signal: controller.signal,
      turnScope: scope,
    });
    const collection = collectEvents(stream);
    const outcome = await Promise.race([
      collection,
      new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 25)),
    ]);
    if (outcome === "still-pending") controller.abort();
    const events = outcome === "still-pending" ? await collection : outcome;
    await scope.dispose();

    expect(outcome).not.toBe("still-pending");
    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toBe("ChatGPT WebSocket idle timeout waiting for connection");
    expect((error?.error as { errorType?: string }).errorType).toBe("network");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
    expect(harness.requests[0]?.socket.terminated).toBe(true);
  });

  test("scoped path preserves close code and reason before completion", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() => socket.emitClose(1011, "upstream unavailable"));
    });
    const events = await collectScopedChatGPTEvents(
      createChatGPTStream(() => testTokens(), {
        useWebSocketForGpt56: true,
        webSocketFactory: harness.factory,
      }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toContain(
      "ChatGPT WebSocket closed before response.completed (1011: upstream unavailable)",
    );
    expect((error?.error as { errorType?: string }).errorType).toBe("network");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
  });

  test("scoped path maps send throws to retryable network errors", async () => {
    const harness = createWebSocketHarness(undefined, {
      sendError: new Error("send failed"),
    });
    const events = await collectScopedChatGPTEvents(
      createChatGPTStream(() => testTokens(), {
        useWebSocketForGpt56: true,
        webSocketFactory: harness.factory,
      }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toBe("ChatGPT WebSocket send failed: send failed");
    expect((error?.error as { errorType?: string }).errorType).toBe("network");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
  });

  test("scoped path classifies top-level provider errors like the unscoped path", async () => {
    const cases: Array<{
      payload: Record<string, unknown>;
      expectedType: string;
      expectedRetryable: boolean;
      expectedStatus?: number;
      expectedReason?: string;
      expectedMessage: string;
    }> = [
      {
        payload: {
          type: "error",
          status: 401,
          error: { type: "authentication_error", message: "unauthorized" },
        },
        expectedType: "auth",
        expectedRetryable: false,
        expectedStatus: 401,
        expectedReason: "credentials_rejected",
        expectedMessage: "unauthorized",
      },
      {
        payload: {
          type: "error",
          status_code: 403,
          error: { message: "forbidden" },
        },
        expectedType: "auth",
        expectedRetryable: false,
        expectedStatus: 403,
        expectedReason: "credentials_rejected",
        expectedMessage: "forbidden",
      },
      {
        payload: {
          type: "error",
          status_code: 429,
          error: { message: "rate limited" },
        },
        expectedType: "rate_limit",
        expectedRetryable: false,
        expectedStatus: 429,
        expectedMessage: "rate limited",
      },
      {
        payload: {
          type: "error",
          status: 429,
          error: {
            type: "usage_limit_reached",
            message: "The usage limit has been reached",
          },
        },
        expectedType: "rate_limit",
        expectedRetryable: false,
        expectedStatus: 429,
        expectedReason: "usage_limit_reached",
        expectedMessage: "usage_limit_reached",
      },
      {
        payload: {
          type: "error",
          status: 400,
          error: {
            code: "websocket_connection_limit_reached",
            message: "Too many WebSocket connections",
          },
        },
        expectedType: "unknown",
        expectedRetryable: true,
        expectedStatus: 400,
        expectedMessage: "websocket_connection_limit_reached",
      },
    ];

    for (const testCase of cases) {
      const harness = createWebSocketHarness((_body, socket) => {
        queueMicrotask(() => socket.emit(testCase.payload));
      });
      const events = await collectScopedChatGPTEvents(
        createChatGPTStream(() => testTokens(), {
          useWebSocketForGpt56: true,
          webSocketFactory: harness.factory,
        }),
      );
      const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");

      expect(error?.error.message).toContain(testCase.expectedMessage);
      expect((error?.error as { errorType?: string }).errorType).toBe(testCase.expectedType);
      expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(testCase.expectedRetryable);
      expect((error?.error as { statusCode?: number }).statusCode).toBe(testCase.expectedStatus);
      expect((error?.error as { reason?: string }).reason).toBe(testCase.expectedReason);
    }
  });

  test("scoped path preserves transient response.failed classification", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() =>
        socket.emit({
          type: "response.failed",
          response: {
            error: {
              message: "ChatGPT is temporarily unavailable. Please try again.",
            },
          },
        }),
      );
    });
    const events = await collectScopedChatGPTEvents(
      createChatGPTStream(() => testTokens(), {
        useWebSocketForGpt56: true,
        webSocketFactory: harness.factory,
      }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect((error?.error as { errorType?: string }).errorType).toBe("server_error");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
  });

  test("scoped path aborts during open and during an active exchange", async () => {
    const openingHarness = createWebSocketHarness(undefined, {
      autoOpen: false,
    });
    const openingController = new AbortController();
    const openingCollection = collectScopedChatGPTEvents(
      createChatGPTStream(() => testTokens(), {
        useWebSocketForGpt56: true,
        webSocketFactory: openingHarness.factory,
      }),
      { signal: openingController.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    openingController.abort();
    await openingCollection;
    expect(openingHarness.requests[0]?.socket.terminated).toBe(true);

    const activeHarness = createWebSocketHarness();
    const activeController = new AbortController();
    const activeCollection = collectScopedChatGPTEvents(
      createChatGPTStream(() => testTokens(), {
        useWebSocketForGpt56: true,
        webSocketFactory: activeHarness.factory,
      }),
      { signal: activeController.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activeHarness.requests[0]?.socket.sent).toHaveLength(1);
    activeController.abort();
    await activeCollection;
    expect(activeHarness.requests[0]?.socket.terminated).toBe(true);
  });

  test("scoped path logs frame byte sizes and payload summaries", async () => {
    process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET = "1";
    const logs: string[] = [];
    console.debug = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    const harness = createWebSocketHarness((_body, socket) => completeWebSocketResponse(socket));
    const events = await collectScopedChatGPTEvents(
      createChatGPTStream(() => testTokens(), {
        useWebSocketForGpt56: true,
        webSocketFactory: harness.factory,
      }),
    );

    expect(logs.some((line) => line.includes("[llm:chatgpt-ws] -> bytes=") && line.includes("response.create"))).toBe(
      true,
    );
    expect(
      logs.some((line) => line.includes("[llm:chatgpt-ws] <- bytes=") && line.includes("response.completed")),
    ).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  test("falls back to HTTP after two scoped WebSocket transport failures", async () => {
    const harness = createWebSocketHarness((_body, socket) => queueMicrotask(() => socket.emitClose()));
    let httpRequests = 0;
    globalThis.fetch = (async () => {
      httpRequests += 1;
      return chatGPTSuccessResponse("fallback");
    }) as unknown as typeof fetch;
    const stream = withRetry(
      createChatGPTStream(() => testTokens(), {
        useWebSocketForGpt56: true,
        webSocketFactory: harness.factory,
      }),
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    );
    const scope = createStreamTurnScope();

    const events = await collectEvents(
      stream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
        turnScope: scope,
      }),
    );

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(harness.requests).toHaveLength(2);
    expect(httpRequests).toBe(1);
    await scope.dispose();
  });

  test("moves ChatGPT GPT-5.6 instructions, tools, and compacted history into Lite HTTP input items", async () => {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return chatGPTSuccessResponse();
    }) as unknown as typeof fetch;
    const chatgptStream = createChatGPTStream(() => testTokens());
    const context: StreamContext = {
      systemPrompt: [{ label: "base", content: "System instructions" }],
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      compactionSummary: { type: "compaction", encrypted_content: "summary" },
      tools: [
        {
          kind: "function",
          name: "read",
          description: "Read a file",
          inputSchema: {
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        { kind: "provider_builtin", capability: "web" },
      ],
    };

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), context, {
        effort: "low",
      }),
    );
    expect(events.some((event) => event.type === "done")).toBe(true);

    const input = requestBody.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      type: "additional_tools",
      role: "developer",
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        { type: "web_search" },
      ],
    });
    expect(input[1]).toEqual({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "System instructions" }],
    });
    expect(input[2]).toEqual({
      type: "compaction",
      encrypted_content: "summary",
    });
    expect(input[3]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    });
  });

  test("keeps existing ChatGPT models on HTTP/SSE", async () => {
    let webSocketCalled = false;
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return chatGPTSuccessResponse();
    }) as unknown as typeof fetch;
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      webSocketFactory() {
        webSocketCalled = true;
        throw new Error("Legacy ChatGPT models must not use WebSocket");
      },
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.5"), TEST_CONTEXT, {
        effort: "medium",
      }),
    );

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(webSocketCalled).toBe(false);
    expect(requestBodies[0]?.model).toBe("gpt-5.5");
    expect(requestBodies[0]?.type).toBeUndefined();
  });

  test("surfaces a retryable error when a GPT-5.6 WebSocket closes before completion", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() => socket.emitClose());
    });
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
      }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error).toBeInstanceOf(Error);
    expect(error?.error.message).toContain("response.completed");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
  });

  test("times out when a GPT-5.6 WebSocket never opens", async () => {
    const harness = createWebSocketHarness(undefined, { autoOpen: false });
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
      webSocketIdleTimeoutMs: 1,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
      }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toBe("ChatGPT WebSocket idle timeout waiting for connection");
    expect((error?.error as { errorType?: string }).errorType).toBe("network");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
    expect(harness.requests[0]?.socket.terminated).toBe(true);
  });

  test("times out after GPT-5.6 WebSocket open while waiting for response", async () => {
    const harness = createWebSocketHarness();
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
      webSocketIdleTimeoutMs: 1,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
      }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(harness.requests[0]?.socket.sent.length).toBe(1);
    expect(error?.error.message).toBe("ChatGPT WebSocket idle timeout waiting for response");
    expect((error?.error as { errorType?: string }).errorType).toBe("network");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
  });

  test("maps GPT-5.6 WebSocket send throws to retryable network errors", async () => {
    const harness = createWebSocketHarness(undefined, {
      sendError: new Error("send failed"),
    });
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
      webSocketIdleTimeoutMs: 100,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
      }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toBe("ChatGPT WebSocket send failed: send failed");
    expect((error?.error as { errorType?: string }).errorType).toBe("network");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
  });

  test("preserves GPT-5.6 WebSocket close code and reason before completion", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() => socket.emitClose(1011, "upstream unavailable"));
    });
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
      }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toContain(
      "ChatGPT WebSocket closed before response.completed (1011: upstream unavailable)",
    );
    expect((error?.error as { errorType?: string }).errorType).toBe("network");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
  });

  test("processes a delayed terminal WebSocket message before close", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      const payload = JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      const delayedBlob = new Blob([payload]);
      Object.defineProperty(delayedBlob, "text", {
        value: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return payload;
        },
      });

      queueMicrotask(() => {
        socket.emitRaw(delayedBlob);
        socket.emitClose(1000, "normal closure");
      });
    });
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
      }),
    );

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("logs ChatGPT WebSocket frames immediately with byte sizes and summaries", async () => {
    process.env.DILIGENT_DEBUG_CHATGPT_WEBSOCKET = "1";
    const logs: string[] = [];
    console.debug = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    let receiveLogSeenBeforeDecode = false;
    let receivedBytes = 0;
    const harness = createWebSocketHarness((_body, socket) => {
      const payload = JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      });
      const delayedBlob = new Blob([payload]);
      Object.defineProperty(delayedBlob, "text", {
        value: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return payload;
        },
      });

      receivedBytes = delayedBlob.size;
      socket.emitRaw(delayedBlob);
      receiveLogSeenBeforeDecode = logs.some((line) => line.includes(`<- bytes=${receivedBytes} pending_decode`));
    });
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
      }),
    );

    expect(receiveLogSeenBeforeDecode).toBe(true);
    expect(logs.some((line) => line.includes("[llm:chatgpt-ws] -> bytes=") && line.includes("response.create"))).toBe(
      true,
    );
    expect(
      logs.some(
        (line) =>
          line.includes(`[llm:chatgpt-ws] <- bytes=${receivedBytes}`) &&
          line.includes("decoded response.completed status=completed in=3 out=2"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  test("maps top-level GPT-5.6 WebSocket errors and terminates on abort", async () => {
    const errorHarness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() =>
        socket.emit({
          type: "error",
          status: 400,
          error: { type: "invalid_request_error", message: "invalid request" },
        }),
      );
    });
    const errorStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: errorHarness.factory,
    });
    const errorEvents = await collectEvents(
      errorStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
      }),
    );
    const error = errorEvents.find(
      (event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error",
    );
    expect(error?.error.message).toContain("invalid request");

    const abortHarness = createWebSocketHarness();
    const abortController = new AbortController();
    const abortStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: abortHarness.factory,
    })(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
      effort: "medium",
      signal: abortController.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();
    await abortStream.result().catch(() => {});

    expect(abortHarness.requests[0]?.socket.terminated).toBe(true);
  });

  test("preserves GPT-5.6 WebSocket usage-limit diagnostics with a stable reason", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() =>
        socket.emit({
          type: "error",
          status: 429,
          error: {
            type: "usage_limit_reached",
            message: "The usage limit has been reached",
          },
        }),
      );
    });
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
      }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toContain("usage_limit_reached");
    expect(error?.error.message).toContain("The usage limit has been reached");
    expect(error?.error.message).not.toContain("upgrade your plan");
    expect((error?.error as { errorType?: string }).errorType).toBe("rate_limit");
    expect((error?.error as { reason?: string }).reason).toBe("usage_limit_reached");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(false);
  });

  test("maps GPT-5.6 WebSocket status_code alias as rate limit", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() =>
        socket.emit({
          type: "error",
          status_code: 429,
          error: { message: "rate limited" },
        }),
      );
    });
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
      }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toContain("ChatGPT API error (429): rate limited");
    expect((error?.error as { errorType?: string }).errorType).toBe("rate_limit");
    expect((error?.error as { statusCode?: number }).statusCode).toBe(429);
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(false);
  });

  test("classifies a WebSocket usage-limit code even without an HTTP status", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() =>
        socket.emit({
          type: "error",
          error: {
            code: "usage_limit_reached",
            message: "The usage limit has been reached",
          },
        }),
      );
    });
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
      }),
    );
    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");

    expect((error?.error as { errorType?: string }).errorType).toBe("rate_limit");
    expect((error?.error as { reason?: string }).reason).toBe("usage_limit_reached");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(false);
  });

  test("maps GPT-5.6 WebSocket connection-limit code as retryable", async () => {
    const harness = createWebSocketHarness((_body, socket) => {
      queueMicrotask(() =>
        socket.emit({
          type: "error",
          status: 400,
          error: {
            code: "websocket_connection_limit_reached",
            message: "Too many WebSocket connections",
          },
        }),
      );
    });
    const chatgptStream = createChatGPTStream(() => testTokens(), {
      useWebSocketForGpt56: true,
      webSocketFactory: harness.factory,
    });

    const events = await collectEvents(
      chatgptStream(resolveModel("chatgpt-5.6-luna"), TEST_CONTEXT, {
        effort: "medium",
      }),
    );

    const error = events.find((event): event is Extract<ProviderEvent, { type: "error" }> => event.type === "error");
    expect(error?.error.message).toContain("websocket_connection_limit_reached");
    expect((error?.error as { isRetryable?: boolean }).isRetryable).toBe(true);
  });
});
