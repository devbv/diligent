// @summary Regression tests for provider transport worker participation in EventStream cleanup
import { afterEach, describe, expect, test } from "bun:test";
import type { OpenAIOAuthTokens } from "../../../src/auth/types";
import { createAnthropicStream } from "../../../src/llm/provider/anthropic";
import { createChatGPTStream } from "../../../src/llm/provider/chatgpt";
import { createOpenAIStream } from "../../../src/llm/provider/openai";
import type { Model, ProviderName, StreamContext, StreamFunction } from "../../../src/llm/types";

const originalFetch = globalThis.fetch;

const context: StreamContext = {
  systemPrompt: [],
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [],
};

function model(provider: ProviderName): Model {
  return {
    modelId: provider === "anthropic" ? "claude-test" : provider === "chatgpt" ? "gpt-5" : "gpt-test",
    provider,
    contextWindow: 100_000,
    maxOutputTokens: 4_096,
    supportsThinking: false,
  };
}

function chatGPTTokens(): OpenAIOAuthTokens {
  return {
    access_token: "token",
    refresh_token: "refresh",
    id_token: "id-token",
    expires_at: Number.MAX_SAFE_INTEGER,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("provider worker tracking", () => {
  for (const [provider, createStream] of [
    ["openai", () => createOpenAIStream("test-key")],
    ["anthropic", () => createAnthropicStream("test-key")],
    ["chatgpt", () => createChatGPTStream(chatGPTTokens)],
  ] as const satisfies ReadonlyArray<readonly [string, () => StreamFunction]>) {
    test(`${provider} waits for transport work to settle after abort`, async () => {
      let markFetchStarted!: () => void;
      const fetchStarted = new Promise<void>((resolve) => {
        markFetchStarted = resolve;
      });
      let rejectFetch!: (error: Error) => void;
      const fetchWork = new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject;
      });
      globalThis.fetch = (() => {
        markFetchStarted();
        return fetchWork;
      }) as unknown as typeof fetch;

      const controller = new AbortController();
      const stream = createStream()(model(provider), context, { signal: controller.signal });
      stream.result().catch(() => {});
      await fetchStarted;
      controller.abort();

      let cleanupSettled = false;
      const cleanup = stream.waitForInnerWork().then(() => {
        cleanupSettled = true;
      });
      await Promise.resolve();
      expect(cleanupSettled).toBe(false);

      rejectFetch(new Error("transport released"));
      await cleanup;
      expect(cleanupSettled).toBe(true);
    });
  }
});
