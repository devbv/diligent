// @summary Gemini-owned model-card definitions
import { defineProviderModels } from "../../model-card";

export const GEMINI_THINKING_BUDGETS = { low: 2_048, medium: 8_192, high: 16_384, max: 24_576 } as const;

export const GEMINI_MODELS = defineProviderModels("gemini", [
  {
    modelId: "gemini-3.1-pro-preview",
    display: "Gemini 3.1 Pro",
    contextWindow: 300_000,
    maxOutputTokens: 65_536,
    inputCostPer1M: 2,
    outputCostPer1M: 12,
    supportsThinking: true,
    supportedEfforts: ["low", "medium", "high", "max"],
    supportsVision: true,
    thinkingBudgets: GEMINI_THINKING_BUDGETS,
    aliases: ["gemini-pro"],
  },
  {
    modelId: "gemini-3.5-flash",
    display: "Gemini 3.5 Flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    inputCostPer1M: 1.5,
    outputCostPer1M: 9,
    supportsThinking: true,
    supportedEfforts: ["low", "medium", "high", "max"],
    supportsVision: true,
    thinkingBudgets: GEMINI_THINKING_BUDGETS,
    aliases: ["gemini-flash", "gemini", "gemini-3-flash-preview"],
  },
  {
    modelId: "gemini-3.1-flash-lite",
    display: "Gemini 3.1 Flash Lite",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    inputCostPer1M: 0.25,
    outputCostPer1M: 1.5,
    supportsThinking: true,
    supportedEfforts: ["low", "medium", "high", "max"],
    supportsVision: true,
    thinkingBudgets: GEMINI_THINKING_BUDGETS,
    aliases: ["gemini-flash-lite", "gemini-3.1-flash-lite-preview"],
  },
]);
