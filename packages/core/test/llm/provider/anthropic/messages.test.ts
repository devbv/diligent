// @summary Tests for Anthropic message conversion and replay filtering
import { describe, expect, test } from "bun:test";
import {
  appendAnthropicConvertedMessage,
  applyAnthropicLastUserCacheBreakpoint,
  buildAnthropicCompactionPrefix,
  convertMessages,
} from "../../../../src/llm/provider/anthropic";
import type { Model } from "../../../../src/llm/types";
import type { AssistantMessage } from "../../../../src/types";

// We test the event mapping logic by creating a mock that simulates
// what createAnthropicStream does internally, without hitting the real SDK.

const TEST_MODEL: Model = {
  id: "claude-sonnet-4-6",
  provider: "anthropic",
  contextWindow: 300_000,
  maxOutputTokens: 16_384,
  supportsThinking: true,
};

function makeAssistantMessage(overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    model: TEST_MODEL.id,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    stopReason: "end_turn",
    timestamp: Date.now(),
    ...overrides,
  };
}
describe("Anthropic message conversion", () => {
  test("exposes pure compaction, coalescing, and cache-breakpoint stages", () => {
    const prefix = buildAnthropicCompactionPrefix({
      type: "compaction",
      content: "summary",
    });
    const appended = appendAnthropicConvertedMessage(prefix, {
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "ok",
            is_error: false,
          },
        ],
      },
      coalesceWithPreviousUser: true,
    });
    const cached = applyAnthropicLastUserCacheBreakpoint(appended);

    expect(prefix).toEqual([{ role: "user", content: [{ type: "text", text: "summary" }] }]);
    expect(appended).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "summary" },
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "ok",
            is_error: false,
          },
        ],
      },
    ]);
    expect(cached).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "summary" },
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "ok",
            is_error: false,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
    expect(appended).not.toBe(cached);
  });

  test("prepends a compaction prefix before follow-up messages", async () => {
    const converted = await convertMessages([{ role: "user", content: "follow-up", timestamp: 1 }], {
      type: "compaction",
      content: " prior compacted context ",
    });

    expect(converted).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "prior compacted context" }],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "follow-up",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  test("coalesces adjacent tool results into one Anthropic user message", async () => {
    const converted = await convertMessages([
      {
        role: "tool_result",
        toolCallId: "tool_1",
        toolName: "first",
        output: "one",
        isError: false,
        timestamp: 1,
      },
      {
        role: "tool_result",
        toolCallId: "tool_2",
        toolName: "second",
        output: "two",
        isError: true,
        timestamp: 2,
      },
    ]);

    expect(converted).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "one",
            is_error: false,
          },
          {
            type: "tool_result",
            tool_use_id: "tool_2",
            content: "two",
            is_error: true,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  test("coalesces a tool result after an ordinary user message", async () => {
    const converted = await convertMessages([
      { role: "user", content: "run it", timestamp: 1 },
      {
        role: "tool_result",
        toolCallId: "tool_1",
        toolName: "bash",
        output: "done",
        isError: false,
        timestamp: 2,
      },
    ]);

    expect(converted).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "run it" },
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "done",
            is_error: false,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  test("keeps text-only tool results as string content", async () => {
    const converted = await convertMessages([
      {
        role: "tool_result",
        toolCallId: "tool_1",
        toolName: "read",
        output: "plain text",
        isError: false,
        timestamp: 1,
      },
    ]);

    expect(converted[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "plain text",
          is_error: false,
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });

  test("converts image-bearing tool results with and without text", async () => {
    const image = {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: "image/png" as const,
        data: "aW1hZ2U=",
      },
    };
    const converted = await convertMessages([
      {
        role: "tool_result",
        toolCallId: "tool_1",
        toolName: "capture",
        output: "caption",
        outputImages: [image],
        isError: false,
        timestamp: 1,
      },
      {
        role: "tool_result",
        toolCallId: "tool_2",
        toolName: "capture",
        output: "",
        outputImages: [image],
        isError: false,
        timestamp: 2,
      },
    ]);

    const blocks = converted[0]?.content;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tool_1",
        content: [
          { type: "text", text: "caption" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aW1hZ2U=",
            },
          },
        ],
        is_error: false,
      },
      {
        type: "tool_result",
        tool_use_id: "tool_2",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aW1hZ2U=",
            },
          },
        ],
        is_error: false,
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  test("places the cache breakpoint on the final block of the last user message", async () => {
    const converted = await convertMessages([
      { role: "user", content: "first", timestamp: 1 },
      makeAssistantMessage({ content: [{ type: "text", text: "reply" }] }),
      {
        role: "user",
        content: [
          { type: "text", text: "second" },
          { type: "text", text: "last" },
        ],
        timestamp: 3,
      },
    ]);

    expect(converted[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "first" }],
    });
    expect(converted[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "second" },
        { type: "text", text: "last", cache_control: { type: "ephemeral" } },
      ],
    });
  });

  test("retains signed Anthropic thinking during replay", async () => {
    const converted = await convertMessages([
      makeAssistantMessage({
        content: [
          { type: "thinking", thinking: "reasoning", signature: "signed" },
          { type: "text", text: "answer" },
        ],
      }),
    ]);

    expect(converted).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", signature: "signed" },
          { type: "text", text: "answer" },
        ],
      },
    ]);
  });

  test("omits all foreign provider-native web replay blocks", async () => {
    const converted = await convertMessages([
      makeAssistantMessage({
        content: [
          {
            type: "provider_tool_use",
            id: "tool_1",
            provider: "openai",
            name: "web_search",
            input: {},
          },
          {
            type: "web_search_result",
            toolUseId: "tool_1",
            provider: "openai",
            results: [],
          },
          {
            type: "web_fetch_result",
            toolUseId: "tool_2",
            provider: "openai",
            url: "https://example.com",
          },
          { type: "text", text: "kept" },
        ],
      }),
    ]);

    expect(converted).toEqual([{ role: "assistant", content: [{ type: "text", text: "kept" }] }]);
  });

  test("replays Anthropic provider-native web blocks as native server tool blocks", async () => {
    const converted = await convertMessages([
      {
        role: "assistant",
        content: [
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
                pageAge: "1 day",
                encryptedContent: "enc1",
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
        ],
        model: TEST_MODEL.id,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        stopReason: "end_turn",
        timestamp: 1,
      },
      {
        role: "tool_result",
        toolCallId: "tc_1",
        toolName: "test_tool",
        output: "ok",
        isError: false,
        timestamp: 2,
      },
    ]);

    expect(converted[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "server_tool_use",
          id: "ws_1",
          name: "web_search",
          input: { query: "diligent" },
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
              source: {
                type: "text",
                media_type: "text/plain",
                data: "Page body",
              },
              title: "Fetched Page",
              citations: { enabled: true },
            },
          },
        },
      ],
    });
    expect(converted[1]?.role).toBe("user");
  });

  test("omits non-Anthropic provider-native blocks during Anthropic replay", async () => {
    const converted = await convertMessages([
      {
        role: "assistant",
        content: [
          {
            type: "provider_tool_use",
            id: "ws_1",
            provider: "openai",
            name: "web_search",
            input: { query: "x" },
          },
          { type: "text", text: "done" },
        ],
        model: TEST_MODEL.id,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        stopReason: "end_turn",
        timestamp: 1,
      },
    ]);

    expect(converted).toEqual([{ role: "assistant", content: [{ type: "text", text: "done" }] }]);
  });

  test("omits assistant thinking blocks without a signature from another provider", async () => {
    const converted = await convertMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning from another provider" },
          { type: "text", text: "done" },
        ],
        model: TEST_MODEL.id,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        stopReason: "end_turn",
        timestamp: 1,
      },
    ]);

    expect(converted).toEqual([{ role: "assistant", content: [{ type: "text", text: "done" }] }]);
  });
});
