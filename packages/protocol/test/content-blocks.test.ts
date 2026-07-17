// @summary Tests for protocol content block schemas
import { describe, expect, test } from "bun:test";
import {
  ProviderToolUseBlockSchema,
  ToolCallBlockSchema,
  WebFetchResultBlockSchema,
  WebSearchResultBlockSchema,
} from "../src/content-blocks";
import { AssistantMessageSchema } from "../src/data-model";

test("AssistantMessageSchema preserves typed OpenAI reasoning state", () => {
  const message = AssistantMessageSchema.parse({
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "summary",
        providerState: {
          provider: "openai",
          itemId: "rs_1",
          encryptedContent: "opaque",
        },
      },
    ],
    model: "gpt-5.6-sol",
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: 1,
  });

  expect(message.content[0]).toMatchObject({
    type: "thinking",
    providerState: { provider: "openai", itemId: "rs_1", encryptedContent: "opaque" },
  });
});

describe("ToolCallBlockSchema", () => {
  test("preserves provider metadata for provider-specific replay fields", () => {
    const parsed = ToolCallBlockSchema.parse({
      type: "tool_call",
      id: "gemini-bash-1",
      name: "bash",
      input: { command: "pwd" },
      providerMetadata: { gemini: { thoughtSignature: "sig-123" } },
    });

    expect(parsed.providerMetadata).toEqual({ gemini: { thoughtSignature: "sig-123" } });
  });
});

describe("provider-native web block schemas", () => {
  test("accept gemini as a provider for web tool blocks", () => {
    expect(
      ProviderToolUseBlockSchema.parse({
        type: "provider_tool_use",
        id: "gemini-web-search",
        provider: "gemini",
        name: "web_search",
        input: { queries: ["diligent"] },
      }).provider,
    ).toBe("gemini");

    expect(
      WebSearchResultBlockSchema.parse({
        type: "web_search_result",
        toolUseId: "gemini-web-search",
        provider: "gemini",
        results: [{ url: "https://example.com", title: "Example" }],
      }).provider,
    ).toBe("gemini");

    expect(
      WebFetchResultBlockSchema.parse({
        type: "web_fetch_result",
        toolUseId: "gemini-web-fetch",
        provider: "gemini",
        url: "https://example.com",
      }).provider,
    ).toBe("gemini");
  });
});
