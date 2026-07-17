// @summary Tests for Gemini provider request conversion and schema compatibility
import { describe, expect, test } from "bun:test";
import { GEMINI_THINKING_BUDGETS } from "../../../src/llm/models";
import {
  buildGeminiGenerateConfig,
  classifyGeminiError,
  convertToGeminiContents,
  convertToGeminiTools,
  extractGeminiWebBlocks,
  resolveGeminiThinkingBudget,
  toGeminiSchema,
} from "../../../src/llm/provider/gemini";
import type { Model, ToolDefinition } from "../../../src/llm/types";
import { ProviderErrorReason, ProviderErrorType } from "../../../src/llm/types";

describe("Gemini content conversion", () => {
  test("converts user image blocks to Gemini inline data parts", async () => {
    const contents = await convertToGeminiContents([
      {
        role: "user",
        timestamp: 1,
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
        ],
      },
    ]);

    expect(contents).toEqual([
      {
        role: "user",
        parts: [{ text: "What is in this image?" }, { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }],
      },
    ]);
  });

  test("preserves Gemini thought signatures on function calls", async () => {
    const contents = await convertToGeminiContents([
      {
        role: "assistant",
        timestamp: 1,
        model: "gemini-3.5-flash",
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        content: [
          {
            type: "tool_call",
            id: "gemini-bash-1",
            name: "bash",
            input: { command: "pwd" },
            providerMetadata: { gemini: { thoughtSignature: "sig-123" } },
          },
        ],
      },
    ]);

    expect(contents).toEqual([
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "bash", args: { command: "pwd" } },
            thoughtSignature: "sig-123",
          },
        ],
      },
    ]);
  });
});

describe("Gemini thinking budget", () => {
  const model: Model = {
    id: "gemini-test",
    provider: "gemini",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    thinkingBudgets: { low: 1_024, medium: 4_096, high: 8_192, max: 32_768 },
  };

  test("maps xhigh to the model max budget", () => {
    expect(resolveGeminiThinkingBudget(model, "xhigh")).toBe(32_768);
  });

  test("uses the model registry budgets as the runtime fallback", () => {
    const modelWithoutBudgets = { ...model, thinkingBudgets: undefined };

    expect(resolveGeminiThinkingBudget(modelWithoutBudgets, "low")).toBe(GEMINI_THINKING_BUDGETS.low);
    expect(resolveGeminiThinkingBudget(modelWithoutBudgets, "medium")).toBe(GEMINI_THINKING_BUDGETS.medium);
    expect(resolveGeminiThinkingBudget(modelWithoutBudgets, "high")).toBe(GEMINI_THINKING_BUDGETS.high);
    expect(resolveGeminiThinkingBudget(modelWithoutBudgets, "max")).toBe(GEMINI_THINKING_BUDGETS.max);
  });
});

describe("Gemini error classification", () => {
  test("uses shared HTTP rules and preserves Gemini context overflow detection", () => {
    expect(classifyGeminiError(Object.assign(new Error("bad credentials"), { status: 403 }))).toMatchObject({
      errorType: ProviderErrorType.Auth,
      reason: ProviderErrorReason.CredentialsRejected,
      isRetryable: false,
    });
    expect(classifyGeminiError(Object.assign(new Error("unavailable"), { status: 503 }))).toMatchObject({
      errorType: ProviderErrorType.ServerError,
      isRetryable: true,
    });
    expect(classifyGeminiError(new Error("input token count exceeds token limit"))).toMatchObject({
      errorType: ProviderErrorType.ContextOverflow,
      reason: ProviderErrorReason.ContextWindowExceeded,
      isRetryable: false,
    });
  });
});

describe("Gemini tool schema conversion", () => {
  test("converts provider-native web capability to Google Search and URL Context tools", () => {
    const tools: ToolDefinition[] = [
      {
        kind: "provider_builtin",
        capability: "web",
      },
    ];

    expect(convertToGeminiTools(tools)).toEqual([{ googleSearch: {} }, { urlContext: {} }]);
  });

  test("combines function declarations with provider-native web tools", () => {
    const tools: ToolDefinition[] = [
      {
        kind: "function",
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        kind: "provider_builtin",
        capability: "web",
      },
    ];

    expect(convertToGeminiTools(tools)).toEqual([
      {
        functionDeclarations: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        ],
      },
      { googleSearch: {} },
      { urlContext: {} },
    ]);
  });

  test("enables server-side tool invocation reporting when web and function tools are combined", () => {
    const tools: ToolDefinition[] = [
      {
        kind: "function",
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        kind: "provider_builtin",
        capability: "web",
      },
    ];

    const config = buildGeminiGenerateConfig(
      {
        systemPrompt: [],
        messages: [],
        tools,
      },
      {},
    );

    expect(config.toolConfig).toEqual({ includeServerSideToolInvocations: true });
  });

  test("does not set server-side invocation reporting for web-only tools", () => {
    const config = buildGeminiGenerateConfig(
      {
        systemPrompt: [],
        messages: [],
        tools: [{ kind: "provider_builtin", capability: "web" }],
      },
      {},
    );

    expect(config.toolConfig).toBeUndefined();
  });

  test("removes JSON Schema keywords rejected by the Gemini API", () => {
    const converted = toGeminiSchema({
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
      properties: {
        count: {
          type: "integer",
          exclusiveMinimum: 0,
          minimum: 0,
        },
      },
      required: ["count"],
      additionalProperties: false,
    });

    expect(converted).toEqual({
      type: "object",
      properties: {
        count: {
          type: "integer",
          minimum: 0,
        },
      },
      required: ["count"],
    });
  });

  test("inlines local schema refs before sending function declarations", () => {
    const tools: ToolDefinition[] = [
      {
        kind: "function",
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: {
            target: { $ref: "#/definitions/Target" },
          },
          required: ["target"],
          definitions: {
            Target: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          },
        },
      },
    ];

    expect(convertToGeminiTools(tools)).toEqual([
      {
        functionDeclarations: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                target: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                  },
                  required: ["path"],
                },
              },
              required: ["target"],
            },
          },
        ],
      },
    ]);
  });

  test("converts nullable type arrays to Gemini nullable schemas", () => {
    expect(
      toGeminiSchema({
        type: "object",
        properties: {
          note: { type: ["string", "null"] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        note: { type: "string", nullable: true },
      },
    });
  });
});

describe("Gemini web metadata normalization", () => {
  test("normalizes grounding metadata into shared web search blocks", () => {
    const blocks = extractGeminiWebBlocks({
      groundingMetadata: {
        webSearchQueries: ["diligent agent"],
        groundingChunks: [
          { web: { uri: "https://example.com/a", title: "A" } },
          { web: { uri: "https://example.com/b" } },
        ],
      },
    });

    expect(blocks).toEqual([
      {
        type: "provider_tool_use",
        id: "gemini-web-search",
        provider: "gemini",
        name: "web_search",
        input: { queries: ["diligent agent"] },
      },
      {
        type: "web_search_result",
        toolUseId: "gemini-web-search",
        provider: "gemini",
        results: [{ url: "https://example.com/a", title: "A" }, { url: "https://example.com/b" }],
      },
    ]);
  });

  test("normalizes URL Context metadata into shared web fetch blocks", () => {
    const blocks = extractGeminiWebBlocks({
      urlContextMetadata: {
        urlMetadata: [
          {
            retrievedUrl: "https://example.com/ok",
            urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
          },
          {
            retrievedUrl: "https://example.com/paywall",
            urlRetrievalStatus: "URL_RETRIEVAL_STATUS_PAYWALL",
          },
        ],
      },
    });

    expect(blocks).toEqual([
      {
        type: "provider_tool_use",
        id: "gemini-web-fetch",
        provider: "gemini",
        name: "web_fetch",
        input: { urls: ["https://example.com/ok", "https://example.com/paywall"] },
      },
      {
        type: "web_fetch_result",
        toolUseId: "gemini-web-fetch",
        provider: "gemini",
        url: "https://example.com/ok",
      },
      {
        type: "web_fetch_result",
        toolUseId: "gemini-web-fetch",
        provider: "gemini",
        url: "https://example.com/paywall",
        error: { code: "URL_RETRIEVAL_STATUS_PAYWALL" },
      },
    ]);
  });
});
