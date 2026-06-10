// @summary Known models registry with resolution logic for aliases, inference, and model classes
import type { Model, ModelInfo, ThinkingEffort } from "./types";

/**
 * Model class tiers — abstract capability levels independent of provider.
 * - pro:     Highest capability, most expensive. For complex reasoning tasks.
 * - general: Balanced cost/capability. Default for most work.
 * - lite:    Cheapest/fastest. Good for read-only exploration and simple tasks.
 */
export type ModelClass = "pro" | "general" | "lite";

export interface ModelDefinition extends Model {
  aliases?: string[];
  modelClass?: ModelClass;
  accessLevel?: string; // OpenAI tier requirement: "standard" | "tier3+" | "enterprise"
}

const GEMINI_THINKING_BUDGETS = { low: 2_048, medium: 8_192, high: 16_384, max: 24_576 } as const;
const THINKING_EFFORTS_WITH_NONE: ThinkingEffort[] = ["none", "low", "medium", "high", "max"];
const THINKING_EFFORTS_WITHOUT_NONE: ThinkingEffort[] = ["low", "medium", "high", "max"];

export const KNOWN_MODELS: ModelDefinition[] = [
  // Anthropic — opus/sonnet/fable use adaptive thinking (model decides budget within cap)
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 5.0,
    outputCostPer1M: 25.0,
    cacheReadCostPer1M: 0.5,
    cacheWriteCostPer1M: 6.25,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITHOUT_NONE,
    supportsVision: true,
    supportsAdaptiveThinking: true,
    thinkingBudgets: { low: 2_000, medium: 8_000, high: 16_000, max: 32_000 },
    aliases: ["claude-opus", "opus", "opus-4-8"],
    modelClass: "pro",
  },
  {
    id: "claude-fable-5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 10.0,
    outputCostPer1M: 50.0,
    cacheReadCostPer1M: 1.0,
    cacheWriteCostPer1M: 12.5,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITHOUT_NONE,
    supportsVision: true,
    supportsAdaptiveThinking: true,
    thinkingBudgets: { low: 2_000, medium: 8_000, high: 16_000, max: 32_000 },
    aliases: ["fable", "fable-5"],
    modelClass: "pro",
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
    cacheReadCostPer1M: 0.3,
    cacheWriteCostPer1M: 3.75,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITHOUT_NONE,
    supportsVision: true,
    supportsAdaptiveThinking: true,
    thinkingBudgets: { low: 1_500, medium: 6_000, high: 12_000, max: 24_000 },
    aliases: ["claude-sonnet", "sonnet"],
    modelClass: "general",
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputCostPer1M: 1.0,
    outputCostPer1M: 5.0,
    cacheReadCostPer1M: 0.1,
    cacheWriteCostPer1M: 1.25,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITHOUT_NONE,
    supportsVision: true,
    thinkingBudgets: { low: 1_024, medium: 3_000, high: 8_000, max: 16_000 },
    aliases: ["claude-haiku", "haiku", "claude-haiku-4-5"],
    modelClass: "lite",
  },
  // Gemini
  {
    id: "gemini-3.1-pro-preview",
    provider: "gemini",
    contextWindow: 300_000,
    maxOutputTokens: 65_536,
    inputCostPer1M: 1.25,
    outputCostPer1M: 10.0,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITH_NONE,
    supportsVision: true,
    thinkingBudgets: GEMINI_THINKING_BUDGETS,
    aliases: ["gemini-pro"],
    modelClass: "pro",
  },
  {
    id: "gemini-3-flash-preview",
    provider: "gemini",
    contextWindow: 300_000,
    maxOutputTokens: 65_536,
    inputCostPer1M: 0.3,
    outputCostPer1M: 2.5,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITH_NONE,
    supportsVision: true,
    thinkingBudgets: GEMINI_THINKING_BUDGETS,
    aliases: ["gemini-flash", "gemini"],
    modelClass: "general",
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    provider: "gemini",
    contextWindow: 300_000,
    maxOutputTokens: 65_536,
    inputCostPer1M: 0.1,
    outputCostPer1M: 0.4,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITH_NONE,
    supportsVision: true,
    thinkingBudgets: GEMINI_THINKING_BUDGETS,
    aliases: ["gemini-flash-lite"],
    modelClass: "lite",
  },
  {
    id: "vertex-gemma-4-26b-it",
    provider: "vertex",
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    supportsThinking: false,
    aliases: ["vertex-gemma", "vertex-gemma-4", "vertex-gemma-4-26b", "gemma-4-26b-vertex", "gemma-vertex"],
    modelClass: "general",
  },
  {
    id: "glm-5.1",
    provider: "zai",
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    supportsVision: false,
    aliases: ["glm", "glm-5", "glm5.1"],
    modelClass: "general",
  },
  // OpenAI — reasoning models: effort mapped to OpenAI's low/medium/high
  // Note: gpt-5.4 supports up to 1M context; capped at 600k to limit cost
  {
    id: "gpt-5.4",
    provider: "openai",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 2.5,
    outputCostPer1M: 15.0,
    cacheReadCostPer1M: 0.25,
    cacheWriteCostPer1M: 0,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITH_NONE,
    supportsVision: true,
    accessLevel: "standard",
    aliases: ["gpt-5"],
    modelClass: "general",
  },
  {
    id: "gpt-5.5",
    provider: "openai",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 5.0,
    outputCostPer1M: 20.0,
    cacheReadCostPer1M: 0.5,
    cacheWriteCostPer1M: 0,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITH_NONE,
    supportsVision: true,
    accessLevel: "standard",
    modelClass: "pro",
  },
  {
    id: "gpt-5.3-codex",
    provider: "openai",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 1.75,
    outputCostPer1M: 14.0,
    cacheReadCostPer1M: 0.175,
    cacheWriteCostPer1M: 0,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITH_NONE,
    supportsVision: true,
    modelClass: "general",
  },
  {
    id: "gpt-5.3-chat-latest",
    provider: "openai",
    contextWindow: 400_000,
    maxOutputTokens: 16_384,
    inputCostPer1M: 1.75,
    outputCostPer1M: 14.0,
    cacheReadCostPer1M: 0.175,
    cacheWriteCostPer1M: 0,
    supportsThinking: false,
    supportsVision: true,
    modelClass: "general",
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 0.75,
    outputCostPer1M: 4.5,
    cacheReadCostPer1M: 0.075,
    cacheWriteCostPer1M: 0,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITH_NONE,
    supportsVision: true,
    modelClass: "lite",
  },
  // ChatGPT subscription models map to the same upstream family, but remain distinct
  // in Diligent so provider identity stays separate from auth strategy.
  {
    id: "chatgpt-5.5",
    provider: "chatgpt",
    contextWindow: 300_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITH_NONE,
    supportsVision: true,
    aliases: ["chatgpt-5.5-pro"],
    modelClass: "pro",
  },
  {
    id: "chatgpt-5.4",
    provider: "chatgpt",
    contextWindow: 300_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 2.5,
    outputCostPer1M: 15.0,
    cacheReadCostPer1M: 0.25,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITH_NONE,
    supportsVision: true,
    modelClass: "general",
  },
  {
    id: "chatgpt-5.3-codex",
    provider: "chatgpt",
    contextWindow: 300_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 1.75,
    outputCostPer1M: 14.0,
    cacheReadCostPer1M: 0.175,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITH_NONE,
    supportsVision: true,
    modelClass: "general",
  },
  {
    id: "chatgpt-5.4-mini",
    provider: "chatgpt",
    contextWindow: 300_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 0.75,
    outputCostPer1M: 4.5,
    cacheReadCostPer1M: 0.075,
    supportsThinking: true,
    supportedEfforts: THINKING_EFFORTS_WITH_NONE,
    supportsVision: true,
    modelClass: "lite",
  },
];

/**
 * Resolve a model for a given provider and model class.
 * Returns the first KNOWN_MODELS entry matching both provider and modelClass.
 * Falls back to the current model if no match is found.
 */
export function resolveModelForClass(currentModel: Model, targetClass: ModelClass): Model {
  const provider = currentModel.provider;

  // If the current model already has this class, return as-is
  const currentDef = KNOWN_MODELS.find((m) => m.id === currentModel.id);
  if (currentDef?.modelClass === targetClass) return currentModel;

  // Find the first known model matching both provider and class
  const match = KNOWN_MODELS.find((m) => m.provider === provider && m.modelClass === targetClass);
  return match ?? currentModel;
}

/**
 * Determine the model class of a given model.
 * Returns the modelClass from KNOWN_MODELS if found, otherwise infers "general".
 */
export function getModelClass(model: Model): ModelClass {
  const def = KNOWN_MODELS.find((m) => m.id === model.id);
  return def?.modelClass ?? "general";
}

/**
 * Map agent type to a default model class.
 * - "explore" agents do read-only work → lite
 * - "general" agents need full capability → same class as parent
 */
export function agentTypeToModelClass(agentType: string, parentModel: Model): ModelClass {
  if (agentType === "explore") return "lite";
  // general: keep the same class as parent
  return getModelClass(parentModel);
}

/**
 * Return the default thinking effort for a given model class.
 * pro → high, general → medium, lite → low
 */
export function getDefaultEffortForClass(modelClass: ModelClass): ThinkingEffort {
  if (modelClass === "pro") return "high";
  if (modelClass === "lite") return "low";
  return "medium";
}

/**
 * Map all known models to the protocol-facing ModelInfo shape.
 */
export function getModelInfoList(): ModelInfo[] {
  return KNOWN_MODELS.map((m) => ({
    id: m.id,
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
  const exact = KNOWN_MODELS.find((m) => m.id === modelId);
  if (exact) return exact;

  // Alias match
  const aliased = KNOWN_MODELS.find((m) => m.aliases?.includes(modelId));
  if (aliased) return aliased;

  // Infer provider from prefix
  if (modelId.startsWith("gemini-")) {
    return {
      id: modelId,
      provider: "gemini",
      contextWindow: 300_000,
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
      provider: "zai",
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
    };
  }
  if (modelId.startsWith("chatgpt-")) {
    return {
      id: modelId,
      provider: "chatgpt",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      supportsThinking: true,
    };
  }
  if (modelId.startsWith("gpt-") || modelId.match(/^o[1-9]/)) {
    return { id: modelId, provider: "openai", contextWindow: 128_000, maxOutputTokens: 16_384, supportsThinking: true };
  }

  // Default to anthropic
  return {
    id: modelId,
    provider: "anthropic",
    contextWindow: 300_000,
    maxOutputTokens: 16_384,
    supportsThinking: true,
  };
}
