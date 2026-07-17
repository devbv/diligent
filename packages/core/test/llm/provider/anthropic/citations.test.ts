// @summary Tests that Anthropic text block citations are preserved in the final assistant message
import { describe, expect, mock, test } from "bun:test";
import { APIError } from "@anthropic-ai/sdk/core/error.mjs";
import type { Model, ProviderEvent, ProviderResult, StreamContext } from "../../../../src/llm/types";

const TEST_ANTHROPIC_MODEL_ID = "claude-sonnet-4-6";

type MockListenerArgs = unknown[];
type MockListener = (...args: MockListenerArgs) => void;
type MockMessagePayload = ProviderResult["message"] | Record<string, unknown>;

const eventHandlers = new Map<string, MockListener[]>();
let finalMessagePayload: MockMessagePayload;

class MockAnthropicStream {
  on(event: string, listener: MockListener) {
    const listeners = eventHandlers.get(event) ?? [];
    listeners.push(listener);
    eventHandlers.set(event, listeners);
    return this;
  }

  async finalMessage() {
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
  modelId: TEST_ANTHROPIC_MODEL_ID,
  provider: "anthropic",
  contextWindow: 300_000,
  maxOutputTokens: 8_000,
  supportsThinking: true,
  supportsAdaptiveThinking: true,
};

const CONTEXT: StreamContext = {
  systemPrompt: [],
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [],
};

describe("Anthropic text citations", () => {
  test("maps web_search_result_location and char_location citations onto text blocks", async () => {
    eventHandlers.clear();
    finalMessagePayload = {
      id: "msg_1",
      role: "assistant",
      model: MODEL.modelId,
      type: "message",
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 4 },
      content: [
        {
          type: "text",
          text: "Uncited intro. ",
          citations: null,
        },
        {
          type: "text",
          text: "Cited claim",
          citations: [
            {
              type: "web_search_result_location",
              url: "https://example.com/a",
              title: "Example A",
              encrypted_index: "enc-idx",
              cited_text: "the claim source text",
            },
            {
              type: "char_location",
              document_index: 2,
              document_title: "Doc",
              start_char_index: 10,
              end_char_index: 42,
              cited_text: "doc snippet",
              file_id: null,
            },
            {
              type: "page_location",
              document_index: 0,
              document_title: null,
              start_page_number: 1,
              end_page_number: 2,
              cited_text: "pdf snippet",
              file_id: null,
            },
          ],
        },
      ],
    };

    const stream = createAnthropicStream("test-key")(MODEL, CONTEXT, { effort: "medium" });
    const events: ProviderEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const done = events.find((event): event is Extract<ProviderEvent, { type: "done" }> => event.type === "done");
    expect(done?.message.content).toEqual([
      { type: "text", text: "Uncited intro. " },
      {
        type: "text",
        text: "Cited claim",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.com/a",
            title: "Example A",
            encryptedIndex: "enc-idx",
            citedText: "the claim source text",
          },
          {
            type: "char_location",
            documentIndex: 2,
            documentTitle: "Doc",
            startCharIndex: 10,
            endCharIndex: 42,
            citedText: "doc snippet",
          },
        ],
      },
    ]);
  });
});
