// @summary Contract tests for the Gemini AI SDK adapter
import { describe, expect, test } from "bun:test";
import { GEMINI_THINKING_BUDGETS } from "../../../src/llm/models";
import {
  buildGeminiProviderOptions,
  buildGeminiTools,
  classifyGeminiError,
  extractGeminiWebBlocks,
  resolveGeminiThinkingBudget,
} from "../../../src/llm/provider/gemini";
import type { Model, ToolDefinition } from "../../../src/llm/types";
import { ProviderErrorReason, ProviderErrorType } from "../../../src/llm/types";

const model: Model = {
  id: "gemini-test",
  provider: "gemini",
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  supportsThinking: true,
  thinkingBudgets: { low: 1_024, medium: 4_096, high: 8_192, max: 32_768 },
};

describe("Gemini thinking", () => {
  test("maps Diligent effort to Gemini's exact thinking budget", () => {
    expect(resolveGeminiThinkingBudget(model, "xhigh")).toBe(32_768);
    expect(buildGeminiProviderOptions(model, { effort: "high" })).toEqual({
      google: { thinkingConfig: { thinkingBudget: 8_192, includeThoughts: true } },
    });
  });

  test("uses model registry budgets as the fallback", () => {
    const modelWithoutBudgets = { ...model, thinkingBudgets: undefined };
    expect(resolveGeminiThinkingBudget(modelWithoutBudgets, "low")).toBe(GEMINI_THINKING_BUDGETS.low);
    expect(resolveGeminiThinkingBudget(modelWithoutBudgets, "medium")).toBe(GEMINI_THINKING_BUDGETS.medium);
    expect(resolveGeminiThinkingBudget(modelWithoutBudgets, "high")).toBe(GEMINI_THINKING_BUDGETS.high);
    expect(resolveGeminiThinkingBudget(modelWithoutBudgets, "max")).toBe(GEMINI_THINKING_BUDGETS.max);
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
