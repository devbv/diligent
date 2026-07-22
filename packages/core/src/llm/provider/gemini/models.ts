// @summary Gemini-owned model-card definitions
import { defineProviderModels } from "../../model-card";
import { defineProviderModelClasses } from "../../model-class";

export const GEMINI_MODEL_CLASSES = defineProviderModelClasses({
  pro: { defaultModelId: "gemini-3.6-flash" },
  general: { defaultModelId: "gemini-3.6-flash" },
  lite: { defaultModelId: "gemini-3.5-flash-lite" },
});

export const GEMINI_MODELS = defineProviderModels("gemini", [
  {
    modelId: "gemini-3.6-flash",
    display: "Gemini 3.6 Flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    inputCostPer1M: 1.5,
    outputCostPer1M: 7.5,
    supportsThinking: true,
    supportedEfforts: ["low", "medium", "high"],
    supportsVision: true,
    aliases: ["gemini-pro", "gemini-flash", "gemini"],
  },
  {
    modelId: "gemini-3.5-flash-lite",
    display: "Gemini 3.5 Flash-Lite",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    inputCostPer1M: 0.3,
    outputCostPer1M: 2.5,
    supportsThinking: true,
    supportedEfforts: ["low", "medium", "high"],
    supportsVision: true,
    aliases: ["gemini-flash-lite"],
  },
]);
