// @summary Tests for Anthropic provider-native web tool content block normalization
import { describe, expect, mock, test } from "bun:test";
import { APIError } from "@anthropic-ai/sdk/core/error.mjs";
import { DEFAULT_ANTHROPIC_MODEL_ID } from "../../../../src/llm/models";
import type { Model, ProviderEvent, ProviderResult, StreamContext } from "../../../../src/llm/types";

type MockListenerArgs = unknown[];
type MockListener = (...args: MockListenerArgs) => void;
type MockMessagePayload = ProviderResult["message"] | Record<string, unknown>;

const eventHandlers = new Map<string, MockListener[]>();
let finalMessagePayload: MockMessagePayload;
let resolveFinalMessage: (() => void) | undefined;
let finalMessageGate: Promise<void> | undefined;

class MockAnthropicStream {
  on(event: string, listener: MockListener) {
    const listeners = eventHandlers.get(event) ?? [];
    listeners.push(listener);
    eventHandlers.set(event, listeners);
    return this;
  }

  async finalMessage() {
    await finalMessageGate;
    return finalMessagePayload;
  }
}

class MockAnthropicClient {
  static APIError = APIError;

  messages = {
    stream: () => new MockAnthropicStream(),
  };
}

mock.module("@anthropic-ai/sdk", () => ({
  default: MockAnthropicClient,
  APIError,
}));

const { createAnthropicStream } = await import("../../../../src/llm/provider/anthropic");

const MODEL: Model = {
  id: DEFAULT_ANTHROPIC_MODEL_ID,
  provider: "anthropic",
  contextWindow: 300_000,
  maxOutputTokens: 8_000,
  supportsThinking: true,
};

const CONTEXT: StreamContext = {
  systemPrompt: [],
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [],
};

function emit(event: string, ...args: MockListenerArgs) {
  for (const listener of eventHandlers.get(event) ?? []) {
    listener(...args);
  }
}

describe("Anthropic native web tools", () => {
  test("normalizes server web tool use and result blocks into content_block events and final message content", async () => {
    eventHandlers.clear();
    finalMessageGate = new Promise<void>((resolve) => {
      resolveFinalMessage = resolve;
    });
    finalMessagePayload = {
      id: "msg_1",
      role: "assistant",
      model: MODEL.id,
      type: "message",
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 4 },
      content: [
        {
          type: "server_tool_use",
          id: "ws_1",
          name: "web_search",
          input: { query: "diligent" },
          caller: { type: "direct" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "ws_1",
          caller: { type: "direct" },
          content: [
            {
              type: "web_search_result",
              url: "https://example.com",
              title: "Example",
              encrypted_content: "enc1",
              page_age: "1 day",
            },
          ],
        },
        {
          type: "server_tool_use",
          id: "wf_1",
          name: "web_fetch",
          input: { url: "https://example.com/page" },
          caller: { type: "direct" },
        },
        {
          type: "web_fetch_tool_result",
          tool_use_id: "wf_1",
          caller: { type: "direct" },
          content: {
            type: "web_fetch_result",
            url: "https://example.com/page",
            retrieved_at: "2026-04-06T00:00:00Z",
            content: {
              type: "document",
              title: "Fetched Page",
              citations: null,
              source: {
                type: "text",
                media_type: "text/plain",
                data: "Page body",
              },
            },
          },
        },
      ],
    };

    const stream = createAnthropicStream("test-key")(MODEL, CONTEXT, { effort: "medium" });
    const collecting = (async () => {
      const events: ProviderEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }
      return events;
    })();

    emit(
      "streamEvent",
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: "ws_1",
          name: "web_search",
          input: { query: "diligent" },
          caller: { type: "direct" },
        },
      },
      finalMessagePayload,
    );
    emit("contentBlock", {
      type: "web_search_tool_result",
      tool_use_id: "ws_1",
      caller: { type: "direct" },
      content: [
        {
          type: "web_search_result",
          url: "https://example.com",
          title: "Example",
          encrypted_content: "enc1",
          page_age: "1 day",
        },
      ],
    });
    resolveFinalMessage?.();

    const events = await collecting;

    const done = events.find((event): event is Extract<ProviderEvent, { type: "done" }> => event.type === "done");
    expect(done?.message.content).toEqual([
      {
        type: "provider_tool_use",
        id: "ws_1",
        provider: "anthropic",
        name: "web_search",
        input: { query: "diligent" },
      },
      {
        type: "web_search_result",
        toolUseId: "ws_1",
        provider: "anthropic",
        results: [
          {
            url: "https://example.com",
            title: "Example",
            encryptedContent: "enc1",
            pageAge: "1 day",
          },
        ],
      },
      {
        type: "provider_tool_use",
        id: "wf_1",
        provider: "anthropic",
        name: "web_fetch",
        input: { url: "https://example.com/page" },
      },
      {
        type: "web_fetch_result",
        toolUseId: "wf_1",
        provider: "anthropic",
        url: "https://example.com/page",
        document: {
          mimeType: "text/plain",
          text: "Page body",
          title: "Fetched Page",
          citationsEnabled: true,
        },
        retrievedAt: "2026-04-06T00:00:00Z",
      },
    ]);
  });
});
