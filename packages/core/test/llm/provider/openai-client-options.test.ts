// @summary Tests that OpenAI SDK clients are constructed with explicit timeout and no retries.

import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { createOpenAIStream, type OpenAIClientFactory } from "../../../src/llm/provider/openai";
import type { Model, StreamContext } from "../../../src/llm/types";

const openAIConstructorOptions: unknown[] = [];
const openAICreateCalls: unknown[] = [];

// Inject a fake client instead of mock.module()-ing "openai". A module mock is process-global and
// leaks its stub OpenAI (whose APIError has a different class identity) into other test files,
// which intermittently broke classifyOpenAIError's `instanceof OpenAI.APIError` checks.
const fakeClientFactory: OpenAIClientFactory = (options) => {
  openAIConstructorOptions.push(options);
  return {
    responses: {
      create: async (params: unknown) => {
        openAICreateCalls.push(params);
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "response.completed",
              response: {
                status: "completed",
                usage: { input_tokens: 1, output_tokens: 1 },
                output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
              },
            };
          },
        };
      },
    },
  } as unknown as OpenAI;
};

const MODEL: Model = {
  id: "gpt-test",
  provider: "openai",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
};

const CONTEXT: StreamContext = {
  systemPrompt: [],
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [],
};

async function runStream(baseUrl?: string) {
  openAIConstructorOptions.length = 0;
  openAICreateCalls.length = 0;
  const stream = createOpenAIStream("test-key", baseUrl, undefined, fakeClientFactory)(MODEL, CONTEXT, {});
  await stream.result();
}

describe("createOpenAIStream", () => {
  test("constructs the SDK client with explicit timeout and no retries", async () => {
    await runStream();

    expect(openAIConstructorOptions).toHaveLength(1);
    expect(openAIConstructorOptions[0]).toEqual({
      apiKey: "test-key",
      baseURL: undefined,
      timeout: 15_000,
      maxRetries: 0,
    });
    expect(openAICreateCalls).toHaveLength(1);
  });

  test("passes through a custom base URL while keeping timeout and retries explicit", async () => {
    await runStream("https://openai-proxy.example/v1");

    expect(openAIConstructorOptions).toHaveLength(1);
    expect(openAIConstructorOptions[0]).toEqual({
      apiKey: "test-key",
      baseURL: "https://openai-proxy.example/v1",
      timeout: 15_000,
      maxRetries: 0,
    });
  });
});
