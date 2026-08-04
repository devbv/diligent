// @summary Contract tests for the Gemini AI SDK adapter
import { describe, expect, test } from "bun:test";
import {
  buildGeminiProviderOptions,
  buildGeminiTools,
  classifyGeminiError,
  extractGeminiWebBlocks,
  resolveGeminiThinkingLevel,
} from "../../../src/llm/provider/gemini";
import type { Model, ToolDefinition } from "../../../src/llm/types";
import { ProviderErrorReason, ProviderErrorType } from "../../../src/llm/types";

const model: Model = {
  modelId: "gemini-test",
  provider: "gemini",
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  supportsThinking: true,
};

describe("Gemini thinking", () => {
  test("maps Diligent effort to the latest Gemini thinking levels", () => {
    expect(resolveGeminiThinkingLevel(model, "low")).toBe("low");
    expect(resolveGeminiThinkingLevel(model, "medium")).toBe("medium");
    expect(resolveGeminiThinkingLevel(model, "high")).toBe("high");
    expect(resolveGeminiThinkingLevel(model, "xhigh")).toBe("high");
    expect(resolveGeminiThinkingLevel(model, "max")).toBe("high");
    expect(buildGeminiProviderOptions(model, { effort: "high" })).toEqual({
      google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } },
    });
  });

  test("omits thinking configuration when effort is unset or thinking is unsupported", () => {
    expect(resolveGeminiThinkingLevel(model, undefined)).toBeUndefined();
    expect(resolveGeminiThinkingLevel({ ...model, supportsThinking: false }, "high")).toBeUndefined();
    expect(buildGeminiProviderOptions(model, {})).toBeUndefined();
  });
});

describe("Gemini tools", () => {
  test("combines Diligent function tools with AI SDK Google web tools", () => {
    const tools: ToolDefinition[] = [
      {
        kind: "function",
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      { kind: "provider_builtin", capability: "web" },
    ];

    expect(Object.keys(buildGeminiTools(tools))).toEqual(["read_file", "google_search", "url_context"]);
  });

  test("normalizes an oversized function schema when native web tools are present", () => {
    const oversizedSchema = {
      type: "object" as const,
      description: "x".repeat(40_000),
      properties: {
        value: {
          anyOf: [
            { type: "object", properties: { text: { type: "string" } } },
            { type: "object", properties: { count: { type: "number" } } },
          ],
        },
      },
    };
    const result = buildGeminiTools([
      { kind: "function", name: "complex_tool", description: "Complex tool", inputSchema: oversizedSchema },
      { kind: "provider_builtin", capability: "web" },
    ]);
    const advertisedSchema = (result.complex_tool as { inputSchema: { jsonSchema: Record<string, unknown> } })
      .inputSchema.jsonSchema;

    expect(advertisedSchema).not.toBe(oversizedSchema);
    expect(advertisedSchema).toMatchObject({
      properties: {
        value: {
          type: "object",
          properties: {
            text: { type: "string" },
            count: { type: "number" },
          },
        },
      },
    });
  });
});

describe("Gemini web metadata normalization", () => {
  test("normalizes AI SDK Google metadata into shared search and fetch blocks", () => {
    expect(
      extractGeminiWebBlocks({
        groundingMetadata: {
          webSearchQueries: ["diligent agent"],
          groundingChunks: [{ web: { uri: "https://example.com/a", title: "A" } }],
        },
        urlContextMetadata: {
          urlMetadata: [
            { retrievedUrl: "https://example.com/ok", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" },
            { retrievedUrl: "https://example.com/paywall", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_PAYWALL" },
          ],
        },
      }),
    ).toEqual([
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
        results: [{ url: "https://example.com/a", title: "A" }],
      },
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

describe("Gemini error classification", () => {
  test("recognizes AI SDK statusCode errors and context overflow", () => {
    expect(classifyGeminiError(Object.assign(new Error("bad credentials"), { statusCode: 403 }))).toMatchObject({
      errorType: ProviderErrorType.Auth,
      reason: ProviderErrorReason.CredentialsRejected,
      isRetryable: false,
    });
    expect(classifyGeminiError(Object.assign(new Error("unavailable"), { statusCode: 503 }))).toMatchObject({
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
