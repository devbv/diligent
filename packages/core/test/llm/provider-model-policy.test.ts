// @summary Tests provider-level default model policy outside model cards
import { describe, expect, it } from "bun:test";
import { resolveModel } from "../../src/llm/models";
import { getDefaultModelId, PROVIDER_MODEL_POLICIES } from "../../src/llm/provider-model-policy";
import type { ProviderName } from "../../src/llm/types";

describe("provider model policy", () => {
  it("defines one provider-owned default model for every provider", () => {
    expect(PROVIDER_MODEL_POLICIES).toEqual({
      anthropic: { defaultModel: "claude-opus-4-8" },
      openai: { defaultModel: "gpt-5.6-sol" },
      chatgpt: { defaultModel: "chatgpt-5.6-sol" },
      gemini: { defaultModel: "gemini-3.5-flash" },
      vertex: { defaultModel: "vertex-gemma-4-26b-it" },
      "zai-coding-plan": { defaultModel: "glm-5.2" },
    });
  });

  it("resolves defaults that belong to the requested provider", () => {
    for (const provider of Object.keys(PROVIDER_MODEL_POLICIES) as ProviderName[]) {
      const modelId = getDefaultModelId(provider);
      expect(resolveModel(modelId).provider).toBe(provider);
    }
  });
});
