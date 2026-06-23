// @summary Static stream resolver — maps providers to built-in stream factories
import { createAnthropicStream } from "./provider/anthropic";
import { createGeminiStream } from "./provider/gemini";
import { createOpenAIStream } from "./provider/openai";
import { createZaiCodingPlanStream } from "./provider/zai-coding-plan";
import type { ProviderName, StreamFunction } from "./types";

const STATIC_STREAM_FACTORIES: Partial<Record<ProviderName, () => StreamFunction>> = {
  anthropic: () => createAnthropicStream(),
  openai: () => createOpenAIStream(),
  gemini: () => createGeminiStream(),
  "zai-coding-plan": () => createZaiCodingPlanStream(),
};

/** Resolve a StreamFunction for the given provider from static factory definitions. */
export function resolveStream(provider: ProviderName): StreamFunction {
  const factory = STATIC_STREAM_FACTORIES[provider];
  if (!factory) {
    throw new Error(
      `No static stream resolver for provider "${provider}". Pass llmMsgStreamFn via AgentOptions (e.g. ProviderManager.createProxyStream for OAuth providers).`,
    );
  }
  return factory();
}
