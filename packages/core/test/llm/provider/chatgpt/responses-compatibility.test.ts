// @summary Tests for GPT-5.6 Responses request and usage compatibility
import { afterEach, describe, expect, test } from "bun:test";
import { buildResponsesRequestBody, isGpt56Model, mapUsage } from "../../../../src/llm/provider/openai/responses";
import { restoreChatGPTStreamTestState } from "../../../helpers/chatgpt-stream";

afterEach(restoreChatGPTStreamTestState);

describe("GPT-5.6 Responses API compatibility", () => {
  test("matches only the official GPT-5.6 model IDs and family alias", () => {
    expect(isGpt56Model("gpt-5.6")).toBe(true);
    expect(isGpt56Model("gpt-5.6-sol")).toBe(true);
    expect(isGpt56Model("gpt-5.6-terra")).toBe(true);
    expect(isGpt56Model("gpt-5.6-luna")).toBe(true);
    expect(isGpt56Model("gpt-5.6-unknown")).toBe(false);
  });

  test("passes GPT-5.5 xhigh through without effort translation", async () => {
    const body = await buildResponsesRequestBody({
      model: "gpt-5.5",
      messages: [],
      useReasoning: true,
      effort: "xhigh",
    });

    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
  });

  test("uses GPT-5.6 reasoning and prompt cache request fields", async () => {
    const body = await buildResponsesRequestBody({
      model: "gpt-5.6-sol",
      messages: [],
      useReasoning: true,
      effort: "max",
      enablePromptCaching: true,
    });

    expect(body.reasoning).toEqual({ effort: "max", summary: "auto" });
    expect(body.prompt_cache_options).toEqual({ ttl: "30m" });
    expect(body.prompt_cache_retention).toBeUndefined();
  });

  test("keeps the legacy prompt cache retention field on GPT-5.5", async () => {
    const body = await buildResponsesRequestBody({
      model: "gpt-5.5",
      messages: [],
      useReasoning: true,
      effort: "xhigh",
      enablePromptCaching: true,
    });

    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(body.prompt_cache_retention).toBe("24h");
    expect(body.prompt_cache_options).toBeUndefined();
  });

  test("separates uncached input, cache reads, and cache writes", () => {
    expect(
      mapUsage({
        input_tokens: 1_000,
        output_tokens: 80,
        input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
      }),
    ).toEqual({
      inputTokens: 500,
      outputTokens: 80,
      cacheReadTokens: 200,
      cacheWriteTokens: 300,
    });
  });

  test("never reports negative uncached input for inconsistent upstream usage", () => {
    expect(
      mapUsage({
        input_tokens: 100,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: 80, cache_write_tokens: 40 },
      }).inputTokens,
    ).toBe(0);
  });
});
