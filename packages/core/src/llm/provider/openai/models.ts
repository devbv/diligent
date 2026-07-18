// @summary OpenAI-owned model-card definitions
import { defineProviderModels } from "../../model-card";
import { defineProviderModelClasses } from "../../model-class";

export const OPENAI_MODEL_CLASSES = defineProviderModelClasses({
  pro: { defaultModelId: "gpt-5.6-sol" },
  general: { defaultModelId: "gpt-5.6-terra" },
  lite: { defaultModelId: "gpt-5.6-luna" },
});

export const OPENAI_MODELS = defineProviderModels("openai", [
  {
    modelId: "gpt-5.5",
    display: "GPT-5.5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 5,
    outputCostPer1M: 30,
    cacheReadCostPer1M: 0.5,
    cacheWriteCostPer1M: 0,
    supportsThinking: true,
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    supportsVision: true,
    accessLevel: "standard",
  },
  {
    modelId: "gpt-5.6-sol",
    display: "GPT-5.6 Sol",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 5,
    outputCostPer1M: 30,
    cacheReadCostPer1M: 0.5,
    cacheWriteCostPer1M: 6.25,
    supportsThinking: true,
    supportsVision: true,
    aliases: ["gpt-5.6", "gpt-5"],
  },
  {
    modelId: "gpt-5.6-terra",
    display: "GPT-5.6 Terra",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 2.5,
    outputCostPer1M: 15,
    cacheReadCostPer1M: 0.25,
    cacheWriteCostPer1M: 3.125,
    supportsThinking: true,
    supportsVision: true,
  },
  {
    modelId: "gpt-5.6-luna",
    display: "GPT-5.6 Luna",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 1,
    outputCostPer1M: 6,
    cacheReadCostPer1M: 0.1,
    cacheWriteCostPer1M: 1.25,
    supportsThinking: true,
    supportsVision: true,
  },
]);
