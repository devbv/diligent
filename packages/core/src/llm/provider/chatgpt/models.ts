// @summary ChatGPT subscription-owned model-card definitions
import { defineProviderModels, GPT_5_5_THINKING_EFFORTS, NATIVE_PROVIDER_THINKING_EFFORTS } from "../../model-card";

export const CHATGPT_MODELS = defineProviderModels("chatgpt", [
  {
    modelId: "gpt-5.5",
    display: "ChatGPT 5.5",
    contextWindow: 300_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportedEfforts: GPT_5_5_THINKING_EFFORTS,
    supportsVision: true,
    aliases: ["gpt-5.5-pro"],
  },
  {
    modelId: "gpt-5.6-sol",
    display: "ChatGPT 5.6 Sol",
    contextWindow: 300_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
    aliases: ["gpt-5.6"],
  },
  {
    modelId: "gpt-5.6-terra",
    display: "ChatGPT 5.6 Terra",
    contextWindow: 300_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
  },
  {
    modelId: "gpt-5.6-luna",
    display: "ChatGPT 5.6 Luna",
    contextWindow: 300_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
  },
]);
