// @summary Provider-level default model selection policy kept outside model cards
import type { ModelRef, ProviderName } from "./types";

export interface ProviderModelPolicy {
  defaultModel: string;
}

export const PROVIDER_MODEL_POLICIES: Readonly<Record<ProviderName, ProviderModelPolicy>> = {
  anthropic: { defaultModel: "claude-opus-4-8" },
  openai: { defaultModel: "gpt-5.6-sol" },
  chatgpt: { defaultModel: "gpt-5.6-sol" },
  gemini: { defaultModel: "gemini-3.6-flash" },
  vertex: { defaultModel: "vertex-gemma-4-26b-it" },
  "zai-coding-plan": { defaultModel: "glm-5.2" },
};

export function getDefaultModelRef(provider: ProviderName): ModelRef {
  return { provider, modelId: PROVIDER_MODEL_POLICIES[provider].defaultModel };
}
