// @summary Tests for Anthropic thinking payload assembly across adaptive and budget-based models
import { describe, expect, mock, test } from "bun:test";
import { APIError } from "@anthropic-ai/sdk/core/error.mjs";
import type { Model, StreamContext, StreamOptions, ToolDefinition } from "../../../../src/llm/types";

const TEST_ANTHROPIC_MODEL_ID = "claude-sonnet-5";

const anthropicCalls: unknown[] = [];
const anthropicConstructorOptions: unknown[] = [];

class MockAnthropicStream {
  on() {
    return this;
  }

  async finalMessage() {
    return {
      id: "msg_123",
      role: "assistant",
      model: TEST_ANTHROPIC_MODEL_ID,
      type: "message",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text: "ok" }],
    };
  }
}

class MockAnthropicClient {
  static APIError = APIError;

  constructor(options: unknown) {
    anthropicConstructorOptions.push(options);
  }

  messages = {
    stream: (params: unknown) => {
      anthropicCalls.push(params);
      return new MockAnthropicStream();
    },
  };
}

mock.module("@anthropic-ai/sdk", () => ({
  default: MockAnthropicClient,
  APIError,
}));

const { createAnthropicStream } = await import("../../../../src/llm/provider/anthropic");

const EMPTY_CONTEXT: StreamContext = {
  systemPrompt: [],
  messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
  tools: [] satisfies ToolDefinition[],
};

function baseModel(overrides: Partial<Model>): Model {
  return {
    modelId: TEST_ANTHROPIC_MODEL_ID,
    provider: "anthropic",
    contextWindow: 300_000,
    maxOutputTokens: 8_000,
    supportsThinking: true,
    supportsAdaptiveThinking: true,
    ...overrides,
  };
}

async function collectRequest(model: Model, options: StreamOptions = { effort: "medium" }) {
  anthropicCalls.length = 0;
  anthropicConstructorOptions.length = 0;
  const stream = createAnthropicStream("test-key")(model, EMPTY_CONTEXT, options);
  await stream.result();
  expect(anthropicCalls).toHaveLength(1);
  return anthropicCalls[0] as Record<string, unknown>;
}

describe("createAnthropicStream", () => {
  test("constructs the SDK client with explicit timeout and no retries", async () => {
    await collectRequest(baseModel({}));

    expect(anthropicConstructorOptions).toHaveLength(1);
    expect(anthropicConstructorOptions[0]).toEqual({
      apiKey: "test-key",
      baseURL: "https://api.anthropic.com",
      timeout: 15_000,
      maxRetries: 0,
    });
  });

  test("passes through a custom base URL while keeping timeout and retries explicit", async () => {
    anthropicCalls.length = 0;
    anthropicConstructorOptions.length = 0;

    const stream = createAnthropicStream("test-key", "https://example.anthropic.local/")(baseModel({}), EMPTY_CONTEXT, {
      effort: "medium",
    });

    await stream.result();

    expect(anthropicConstructorOptions).toHaveLength(1);
    expect(anthropicConstructorOptions[0]).toEqual({
      apiKey: "test-key",
      baseURL: "https://example.anthropic.local",
      timeout: 15_000,
      maxRetries: 0,
    });
  });

  test("uses adaptive thinking without budget_tokens and sends output_config effort", async () => {
    const request = await collectRequest(
      baseModel({
        supportsAdaptiveThinking: true,
      }),
      { effort: "high" },
    );

    expect(request.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(request.output_config).toEqual({ effort: "high" });
    expect(request.temperature).toBeUndefined();
  });

  test("preserves xhigh for adaptive models with intrinsic xhigh support", async () => {
    const request = await collectRequest(baseModel({ supportsAdaptiveThinking: true, supportsXhighEffort: true }), {
      effort: "xhigh",
    });

    expect(request.output_config).toEqual({ effort: "xhigh" });
  });

  test("maps xhigh to max for adaptive models without xhigh support", async () => {
    const request = await collectRequest(baseModel({ supportsAdaptiveThinking: true, supportsXhighEffort: false }), {
      effort: "xhigh",
    });

    expect(request.output_config).toEqual({ effort: "max" });
  });

  test("defaults missing effort to medium adaptive thinking", async () => {
    const request = await collectRequest(baseModel({ supportsAdaptiveThinking: true }), {});

    expect(request.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(request.output_config).toEqual({ effort: "medium" });
  });

  test("uses budget_tokens for non-adaptive thinking models", async () => {
    const request = await collectRequest(
      baseModel({
        modelId: "claude-haiku-4-5",
        supportsAdaptiveThinking: false,
        thinkingBudgets: { low: 1_024, medium: 3_000, high: 8_000, max: 16_000 },
      }),
      { effort: "medium" },
    );

    expect(request.thinking).toEqual({ type: "enabled", budget_tokens: 3_000, display: "summarized" });
    expect(request.output_config).toBeUndefined();
    expect(request.temperature).toBeUndefined();
  });

  test("uses the max budget when a non-adaptive model receives xhigh", async () => {
    const request = await collectRequest(
      baseModel({
        maxOutputTokens: 64_000,
        supportsAdaptiveThinking: false,
        thinkingBudgets: { low: 1_024, medium: 3_000, high: 8_000, max: 16_000 },
      }),
      { effort: "xhigh" },
    );

    expect(request.thinking).toEqual({ type: "enabled", budget_tokens: 16_000, display: "summarized" });
  });

  test("rejects manual thinking budgets that are not below max_tokens", async () => {
    const stream = createAnthropicStream("test-key")(
      baseModel({
        modelId: "claude-haiku-4-5",
        supportsAdaptiveThinking: false,
        thinkingBudgets: { low: 1_024, medium: 3_000, high: 8_000, max: 16_000 },
      }),
      EMPTY_CONTEXT,
      { effort: "max", maxTokens: 16_000 },
    );

    await expect(stream.result()).rejects.toThrow("must be less than max_tokens");
  });

  test("rejects manual thinking models without explicit budgets", async () => {
    const stream = createAnthropicStream("test-key")(
      baseModel({ modelId: "claude-unknown", supportsAdaptiveThinking: false }),
      EMPTY_CONTEXT,
      { effort: "medium" },
    );

    await expect(stream.result()).rejects.toThrow("does not define thinking budgets");
  });

  test("uses caller temperature for models that do not support thinking", async () => {
    const request = await collectRequest(
      baseModel({
        supportsThinking: false,
      }),
      { effort: "medium", temperature: 0.25 },
    );

    expect(request.thinking).toBeUndefined();
    expect(request.output_config).toBeUndefined();
    expect(request.temperature).toBe(0.25);
  });

  test("adds Anthropic native web_search tool for provider web capability", async () => {
    await collectRequest(baseModel({}), {
      effort: "medium",
    });

    const stream = createAnthropicStream("test-key")(
      baseModel({}),
      {
        ...EMPTY_CONTEXT,
        tools: [
          {
            kind: "provider_builtin",
            capability: "web",
            options: {
              allowedDomains: ["example.com"],
              maxUses: 2,
              userLocation: { type: "approximate", country: "US", region: "CA" },
            },
          },
        ],
      },
      { effort: "medium" },
    );

    await stream.result();
    const lastRequest = anthropicCalls.at(-1) as Record<string, unknown>;
    expect(lastRequest.tools).toEqual([
      {
        type: "web_search_20260209",
        name: "web_search",
        allowed_callers: ["direct"],
        allowed_domains: ["example.com"],
        max_uses: 2,
        user_location: { type: "approximate", country: "US", region: "CA" },
      },
    ]);
  });

  test("adds Anthropic native web_fetch tool when maxContentTokens is configured", async () => {
    const stream = createAnthropicStream("test-key")(
      baseModel({}),
      {
        ...EMPTY_CONTEXT,
        tools: [
          {
            kind: "provider_builtin",
            capability: "web",
            options: {
              allowedDomains: ["example.com"],
              maxContentTokens: 4000,
              citationsEnabled: false,
              userLocation: { type: "approximate", country: "US" },
            },
          },
        ],
      },
      { effort: "medium" },
    );

    await stream.result();
    const lastRequest = anthropicCalls.at(-1) as Record<string, unknown>;
    expect(lastRequest.tools).toEqual([
      {
        type: "web_fetch_20260209",
        name: "web_fetch",
        allowed_callers: ["direct"],
        allowed_domains: ["example.com"],
        max_content_tokens: 4000,
        citations: { enabled: false },
      },
    ]);
  });

  test("reuses compactionSummary as a synthetic user message in standard Anthropic requests", async () => {
    anthropicCalls.length = 0;
    const stream = createAnthropicStream("test-key")(
      baseModel({}),
      {
        ...EMPTY_CONTEXT,
        compactionSummary: { type: "compaction", content: "prior compacted context" },
      },
      { effort: "medium" },
    );

    await stream.result();
    const request = anthropicCalls.at(-1) as { messages: Array<{ role: string; content: unknown[] }> };
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "prior compacted context" }],
    });
    expect(request.messages[1]?.role).toBe("user");
    expect(request.messages[1]?.content).toEqual([
      { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
    ]);
  });
});
