// @summary Versioned model-card catalog with intrinsic capabilities, metadata, and resolution
import type { Model, ModelInfo, ThinkingEffort } from "./types";

export const MODEL_CARD_SCHEMA_VERSION = 1 as const;

export type ModelCardLifecycle = "preview" | "stable" | "deprecated";

export interface ModelCardProvenance {
  source: string;
  sourceUrl?: string;
  updatedAt?: string;
}

/**
 * Canonical metadata for a concrete provider model.
 *
 * Runtime-required model capabilities remain flattened through `Model` for provider
 * compatibility. Optional metadata and `extensions` allow richer catalogs (including
 * AI SDK or gateway data) without leaking Diligent's model-class routing policy here.
 */
export interface ModelCard extends Model {
  schemaVersion: typeof MODEL_CARD_SCHEMA_VERSION;
  aliases?: string[];
  accessLevel?: string; // OpenAI tier requirement: "standard" | "tier3+" | "enterprise"
  display?: string; // Human-facing label for the picker; falls back to `id` when unset.
  description?: string;
  ownedBy?: string;
  releasedAt?: string;
  knowledgeCutoff?: string;
  lifecycle?: ModelCardLifecycle;
  tags?: string[];
  provenance?: ModelCardProvenance;
  extensions?: Record<string, unknown>;
}

type ModelCardInput = Omit<ModelCard, "schemaVersion">;

function defineModelCards(cards: ModelCardInput[]): ModelCard[] {
  return cards.map((card) => ({ schemaVersion: MODEL_CARD_SCHEMA_VERSION, ...card }));
}

export const GEMINI_THINKING_BUDGETS = { low: 2_048, medium: 8_192, high: 16_384, max: 24_576 } as const;
const NATIVE_PROVIDER_THINKING_EFFORTS: ThinkingEffort[] = ["low", "medium", "high", "xhigh", "max"];

export const MODEL_CARDS: ModelCard[] = defineModelCards([
  // Anthropic — opus/sonnet/fable use adaptive thinking (model decides budget within cap)
  {
    id: "claude-opus-4-8",
    display: "Claude Opus 4.8",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 5.0,
    outputCostPer1M: 25.0,
    cacheReadCostPer1M: 0.5,
    cacheWriteCostPer1M: 6.25,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
    supportsAdaptiveThinking: true,
    thinkingBudgets: { low: 2_000, medium: 8_000, high: 16_000, max: 32_000 },
    aliases: ["claude-opus", "opus", "opus-4-8"],
  },
  {
    id: "claude-fable-5",
    display: "Claude Fable 5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 10.0,
    outputCostPer1M: 50.0,
    cacheReadCostPer1M: 1.0,
    cacheWriteCostPer1M: 12.5,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
    supportsAdaptiveThinking: true,
    thinkingBudgets: { low: 2_000, medium: 8_000, high: 16_000, max: 32_000 },
    aliases: ["fable", "fable-5"],
  },
  {
    id: "claude-sonnet-5",
    display: "Claude Sonnet 5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
    cacheReadCostPer1M: 0.3,
    cacheWriteCostPer1M: 3.75,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
    supportsAdaptiveThinking: true,
    thinkingBudgets: { low: 1_500, medium: 6_000, high: 12_000, max: 24_000 },
    aliases: ["sonnet-5"],
  },
  {
    id: "claude-sonnet-4-6",
    display: "Claude Sonnet 4.6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
    cacheReadCostPer1M: 0.3,
    cacheWriteCostPer1M: 3.75,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
    supportsAdaptiveThinking: true,
    thinkingBudgets: { low: 1_500, medium: 6_000, high: 12_000, max: 24_000 },
    aliases: ["claude-sonnet", "sonnet", "sonnet-4-6"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    display: "Claude Haiku 4.5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputCostPer1M: 1.0,
    outputCostPer1M: 5.0,
    cacheReadCostPer1M: 0.1,
    cacheWriteCostPer1M: 1.25,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
    thinkingBudgets: { low: 1_024, medium: 3_000, high: 8_000, max: 16_000 },
    aliases: ["claude-haiku", "haiku", "claude-haiku-4-5"],
  },
  // Gemini
  {
    id: "gemini-3.1-pro-preview",
    display: "Gemini 3.1 Pro",
    provider: "gemini",
    contextWindow: 300_000,
    maxOutputTokens: 65_536,
    inputCostPer1M: 2.0,
    outputCostPer1M: 12.0,
    supportsThinking: true,
    supportedEfforts: ["none", "low", "medium", "high", "max"],
    supportsVision: true,
    thinkingBudgets: GEMINI_THINKING_BUDGETS,
    aliases: ["gemini-pro"],
  },
  {
    id: "gemini-3.5-flash",
    display: "Gemini 3.5 Flash",
    provider: "gemini",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    inputCostPer1M: 1.5,
    outputCostPer1M: 9.0,
    supportsThinking: true,
    supportedEfforts: ["none", "low", "medium", "high", "max"],
    supportsVision: true,
    thinkingBudgets: GEMINI_THINKING_BUDGETS,
    aliases: ["gemini-flash", "gemini", "gemini-3-flash-preview"],
  },
  {
    id: "gemini-3.1-flash-lite",
    display: "Gemini 3.1 Flash Lite",
    provider: "gemini",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    inputCostPer1M: 0.25,
    outputCostPer1M: 1.5,
    supportsThinking: true,
    supportedEfforts: ["none", "low", "medium", "high", "max"],
    supportsVision: true,
    thinkingBudgets: GEMINI_THINKING_BUDGETS,
    aliases: ["gemini-flash-lite", "gemini-3.1-flash-lite-preview"],
  },
  {
    id: "vertex-gemma-4-26b-it",
    display: "Gemma 4 26B (Vertex)",
    provider: "vertex",
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    supportsThinking: false,
    aliases: ["vertex-gemma", "vertex-gemma-4", "vertex-gemma-4-26b", "gemma-4-26b-vertex", "gemma-vertex"],
  },
  {
    id: "glm-5.2",
    display: "GLM 5.2",
    provider: "zai-coding-plan",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportedEfforts: ["low", "medium", "high", "max"],
    supportsVision: false,
    aliases: ["glm", "glm-5", "glm5.2"],
  },
  {
    id: "glm-5.1",
    display: "GLM 5.1",
    provider: "zai-coding-plan",
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    supportsVision: false,
    aliases: ["glm5.1"],
  },
  // Keep the retained GPT-5.5 pro model before the current GPT-5.6 family.
  {
    id: "gpt-5.5",
    display: "GPT-5.5",
    provider: "openai",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 5.0,
    outputCostPer1M: 30.0,
    cacheReadCostPer1M: 0.5,
    cacheWriteCostPer1M: 0,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
    accessLevel: "standard",
  },
  // GPT-5.6 owns the current pro/general/lite family aliases and class routes.
  {
    id: "gpt-5.6-sol",
    display: "GPT-5.6 Sol",
    provider: "openai",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 5.0,
    outputCostPer1M: 30.0,
    cacheReadCostPer1M: 0.5,
    cacheWriteCostPer1M: 6.25,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
    aliases: ["gpt-5.6", "gpt-5"],
  },
  {
    id: "gpt-5.6-terra",
    display: "GPT-5.6 Terra",
    provider: "openai",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 2.5,
    outputCostPer1M: 15.0,
    cacheReadCostPer1M: 0.25,
    cacheWriteCostPer1M: 3.125,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
  },
  {
    id: "gpt-5.6-luna",
    display: "GPT-5.6 Luna",
    provider: "openai",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 1.0,
    outputCostPer1M: 6.0,
    cacheReadCostPer1M: 0.1,
    cacheWriteCostPer1M: 1.25,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
  },
  // ChatGPT subscription models map to upstream GPT slugs, but remain distinct in
  // Diligent so provider identity stays separate from the OpenAI API auth strategy.
  // The public Codex catalog does not publish subscription-specific context limits,
  // so these entries retain the existing conservative 300K ChatGPT runtime budget.
  {
    id: "chatgpt-5.5",
    display: "ChatGPT 5.5",
    provider: "chatgpt",
    contextWindow: 300_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
    aliases: ["chatgpt-5.5-pro"],
  },
  {
    id: "chatgpt-5.6-sol",
    display: "ChatGPT 5.6 Sol",
    provider: "chatgpt",
    contextWindow: 300_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
    aliases: ["chatgpt-5.6"],
  },
  {
    id: "chatgpt-5.6-terra",
    display: "ChatGPT 5.6 Terra",
    provider: "chatgpt",
    contextWindow: 300_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
  },
  {
    id: "chatgpt-5.6-luna",
    display: "ChatGPT 5.6 Luna",
    provider: "chatgpt",
    contextWindow: 300_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
  },
]);

/**
 * Map all known models to the protocol-facing ModelInfo shape.
 */
export function getModelInfoList(): ModelInfo[] {
  return MODEL_CARDS.map((m) => ({
    id: m.id,
    display: m.display,
    provider: m.provider,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    inputCostPer1M: m.inputCostPer1M,
    outputCostPer1M: m.outputCostPer1M,
    supportsThinking: m.supportsThinking,
    supportedEfforts: m.supportedEfforts,
    supportsVision: m.supportsVision,
  }));
}

/**
 * Resolve a model ID or alias to a full Model.
 * For unknown models, infer provider from ID prefix.
 */
export function resolveModel(modelId: string): Model {
  // Exact match
  const exact = MODEL_CARDS.find((m) => m.id === modelId);
  if (exact) return exact;

  // Alias match
  const aliased = MODEL_CARDS.find((m) => m.aliases?.includes(modelId));
  if (aliased) return aliased;

  // Infer provider from prefix
  if (modelId.startsWith("gemini-")) {
    return {
      id: modelId,
      provider: "gemini",
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      supportsThinking: true,
    };
  }
  if (modelId.startsWith("vertex-")) {
    return {
      id: modelId,
      provider: "vertex",
      contextWindow: 256_000,
      maxOutputTokens: 8_192,
      supportsThinking: false,
    };
  }
  if (modelId.startsWith("glm-")) {
    return {
      id: modelId,
      provider: "zai-coding-plan",
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
      supportsThinking: false,
    };
  }
  if (modelId.startsWith("claude-")) {
    return {
      id: modelId,
      provider: "anthropic",
      contextWindow: 300_000,
      maxOutputTokens: 16_384,
      supportsThinking: true,
      supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    };
  }
  if (modelId.startsWith("chatgpt-")) {
    return {
      id: modelId,
      provider: "chatgpt",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      supportsThinking: true,
      supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    };
  }
  if (modelId.startsWith("gpt-") || modelId.match(/^o[1-9]/)) {
    return {
      id: modelId,
      provider: "openai",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      supportsThinking: true,
      supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    };
  }

  // Default to anthropic
  return {
    id: modelId,
    provider: "anthropic",
    contextWindow: 300_000,
    maxOutputTokens: 16_384,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
  };
}
