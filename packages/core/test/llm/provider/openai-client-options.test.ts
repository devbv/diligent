// @summary Tests that OpenAI SDK clients are constructed with explicit timeout and no retries.
import { describe, expect, test } from "bun:test";
import { createOpenAIClient } from "../../../src/llm/provider/openai";

describe("createOpenAIClient", () => {
  test("constructs the SDK client with explicit timeout and no retries", () => {
    const client = createOpenAIClient("test-key");

    expect(client.apiKey).toBe("test-key");
    expect(client.baseURL).toBe("https://api.openai.com/v1");
    expect(client.timeout).toBe(15_000);
    expect(client.maxRetries).toBe(0);
  });

  test("passes through a custom base URL while keeping timeout and retries explicit", () => {
    const client = createOpenAIClient("test-key", "https://openai-proxy.example/v1");

    expect(client.baseURL).toBe("https://openai-proxy.example/v1");
    expect(client.timeout).toBe(15_000);
    expect(client.maxRetries).toBe(0);
  });
});
