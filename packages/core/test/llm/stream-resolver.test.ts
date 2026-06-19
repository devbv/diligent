// @summary Tests for static stream resolver behavior
import { afterEach, describe, expect, test } from "bun:test";
import { resolveStream } from "../../src/llm/stream-resolver";

const ORIGINAL_ENV = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  ZAI_CODING_PLAN_API_KEY: process.env.ZAI_CODING_PLAN_API_KEY,
};

function restoreEnv(): void {
  if (ORIGINAL_ENV.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_ENV.ANTHROPIC_API_KEY;

  if (ORIGINAL_ENV.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_ENV.OPENAI_API_KEY;

  if (ORIGINAL_ENV.GEMINI_API_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIGINAL_ENV.GEMINI_API_KEY;

  if (ORIGINAL_ENV.ZAI_CODING_PLAN_API_KEY === undefined) delete process.env.ZAI_CODING_PLAN_API_KEY;
  else process.env.ZAI_CODING_PLAN_API_KEY = ORIGINAL_ENV.ZAI_CODING_PLAN_API_KEY;
}

afterEach(() => {
  restoreEnv();
});

describe("resolveStream", () => {
  test("returns a static anthropic stream factory", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(typeof resolveStream("anthropic")).toBe("function");
  });

  test("provider layer enforces env fallback requirements", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const build = () => resolveStream("anthropic");
    expect(build).toThrow(
      "Anthropic API key is required. Set ANTHROPIC_API_KEY or pass apiKey to createAnthropicStream().",
    );
  });

  test("throws for unsupported static provider resolver", () => {
    expect(() => resolveStream("chatgpt")).toThrow(
      'No static stream resolver for provider "chatgpt". Pass llmMsgStreamFn via AgentOptions (e.g. ProviderManager.createProxyStream for OAuth providers).',
    );
  });

  test("returns a static zai-coding-plan stream factory", () => {
    process.env.ZAI_CODING_PLAN_API_KEY = "zai-test";
    expect(typeof resolveStream("zai-coding-plan")).toBe("function");
  });
});
