import type { Model } from "./types";

export interface ModelDefinition extends Model {
  aliases?: string[];
}

export const KNOWN_MODELS: ModelDefinition[] = [
  // Anthropic
  {
    id: "claude-sonnet-4-20250514",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
    aliases: ["claude-sonnet", "sonnet"],
  },
  {
    id: "claude-haiku-3-5-20241022",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    inputCostPer1M: 0.8,
    outputCostPer1M: 4.0,
    aliases: ["claude-haiku", "haiku"],
  },
  // OpenAI
  {
    id: "gpt-4o",
    provider: "openai",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPer1M: 2.5,
    outputCostPer1M: 10.0,
    aliases: ["4o"],
  },
  {
    id: "gpt-4o-mini",
    provider: "openai",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.6,
    aliases: ["4o-mini"],
  },
  {
    id: "o3",
    provider: "openai",
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    inputCostPer1M: 10.0,
    outputCostPer1M: 40.0,
  },
];

/**
 * Resolve a model ID or alias to a full Model.
 * For unknown models, infer provider from ID prefix.
 */
export function resolveModel(modelId: string): Model {
  // Exact match
  const exact = KNOWN_MODELS.find((m) => m.id === modelId);
  if (exact) return exact;

  // Alias match
  const aliased = KNOWN_MODELS.find((m) => m.aliases?.includes(modelId));
  if (aliased) return aliased;

  // Infer provider from prefix
  if (modelId.startsWith("claude-")) {
    return { id: modelId, provider: "anthropic", contextWindow: 200_000, maxOutputTokens: 16_384 };
  }
  if (modelId.startsWith("gpt-") || modelId.startsWith("o1") || modelId.startsWith("o3")) {
    return { id: modelId, provider: "openai", contextWindow: 128_000, maxOutputTokens: 16_384 };
  }

  // Default to anthropic
  return { id: modelId, provider: "anthropic", contextWindow: 200_000, maxOutputTokens: 16_384 };
}
