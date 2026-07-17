// @summary Versioned model-card catalog with intrinsic capabilities, metadata, and resolution
import type { Model, ModelInfo, ModelRef, ProviderName, ThinkingEffort } from "./types";

export const MODEL_CARD_SCHEMA_VERSION = 1 as const;

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
  display?: string; // Human-facing label for the picker; falls back to `modelId` when unset.
  description?: string;
  ownedBy?: string;
  releasedAt?: string;
  knowledgeCutoff?: string;
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
const GPT_5_5_THINKING_EFFORTS: ThinkingEffort[] = ["low", "medium", "high", "xhigh"];

const MODEL_CARDS = defineModelCards([
  // Anthropic — Opus/Sonnet/Fable use adaptive thinking; Haiku uses manual budgets.
  {
    modelId: "claude-opus-4-8",
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
    supportsXhighEffort: true,
    aliases: ["claude-opus", "opus", "opus-4-8"],
  },
  {
    modelId: "claude-fable-5",
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
    supportsXhighEffort: true,
    aliases: ["fable", "fable-5"],
  },
  {
    modelId: "claude-sonnet-5",
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
    supportsXhighEffort: true,
    aliases: ["sonnet-5"],
  },
  {
    modelId: "claude-sonnet-4-6",
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
    aliases: ["claude-sonnet", "sonnet", "sonnet-4-6"],
  },
  {
    modelId: "claude-haiku-4-5-20251001",
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
    modelId: "gemini-3.1-pro-preview",
    display: "Gemini 3.1 Pro",
    provider: "gemini",
    contextWindow: 300_000,
    maxOutputTokens: 65_536,
    inputCostPer1M: 2.0,
    outputCostPer1M: 12.0,
    supportsThinking: true,
    supportedEfforts: ["low", "medium", "high", "max"],
    supportsVision: true,
    thinkingBudgets: GEMINI_THINKING_BUDGETS,
    aliases: ["gemini-pro"],
  },
  {
    modelId: "gemini-3.5-flash",
    display: "Gemini 3.5 Flash",
    provider: "gemini",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    inputCostPer1M: 1.5,
    outputCostPer1M: 9.0,
    supportsThinking: true,
    supportedEfforts: ["low", "medium", "high", "max"],
    supportsVision: true,
    thinkingBudgets: GEMINI_THINKING_BUDGETS,
    aliases: ["gemini-flash", "gemini", "gemini-3-flash-preview"],
  },
  {
    modelId: "gemini-3.1-flash-lite",
    display: "Gemini 3.1 Flash Lite",
    provider: "gemini",
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
  {
    modelId: "vertex-gemma-4-26b-it",
    display: "Gemma 4 26B (Vertex)",
    provider: "vertex",
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    supportsThinking: false,
    aliases: ["vertex-gemma", "vertex-gemma-4", "vertex-gemma-4-26b", "gemma-4-26b-vertex", "gemma-vertex"],
  },
  {
    modelId: "glm-5.2",
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
    modelId: "glm-5.1",
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
    modelId: "gpt-5.5",
    display: "GPT-5.5",
    provider: "openai",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPer1M: 5.0,
    outputCostPer1M: 30.0,
    cacheReadCostPer1M: 0.5,
    cacheWriteCostPer1M: 0,
    supportsThinking: true,
    supportedEfforts: GPT_5_5_THINKING_EFFORTS,
    supportsVision: true,
    accessLevel: "standard",
  },
  // GPT-5.6 owns the current pro/general/lite family aliases and class routes.
  {
    modelId: "gpt-5.6-sol",
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
    modelId: "gpt-5.6-terra",
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
    modelId: "gpt-5.6-luna",
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
    modelId: "gpt-5.5",
    display: "ChatGPT 5.5",
    provider: "chatgpt",
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
    provider: "chatgpt",
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
    provider: "chatgpt",
    contextWindow: 300_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
  },
  {
    modelId: "gpt-5.6-luna",
    display: "ChatGPT 5.6 Luna",
    provider: "chatgpt",
    contextWindow: 300_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportedEfforts: NATIVE_PROVIDER_THINKING_EFFORTS,
    supportsVision: true,
  },
]);

const providers = ["anthropic", "openai", "chatgpt", "gemini", "vertex", "zai-coding-plan"] as const;
const catalog = Object.fromEntries(providers.map((provider) => [provider, {}])) as Record<
  ProviderName,
  Record<string, ModelCard>
>;
const lookup = new Map<ProviderName, Map<string, ModelCard>>(providers.map((provider) => [provider, new Map()]));

for (const card of MODEL_CARDS) {
  const providerLookup = lookup.get(card.provider);
  if (!providerLookup) throw new Error(`Unsupported model provider: ${card.provider}`);
  if (providerLookup.has(card.modelId)) throw new Error(`Duplicate model identity: ${card.provider}/${card.modelId}`);
  catalog[card.provider][card.modelId] = card;
  providerLookup.set(card.modelId, card);
  for (const alias of card.aliases ?? []) {
    if (providerLookup.has(alias)) throw new Error(`Duplicate model alias: ${card.provider}/${alias}`);
    providerLookup.set(alias, card);
  }
}

/** Provider-scoped model-card source exposed as readonly catalog snapshots. */
export const MODEL_CATALOG: Readonly<Record<ProviderName, Readonly<Record<string, ModelCard>>>> = catalog;

export class UnknownModelError extends Error {
  constructor(public readonly ref: ModelRef) {
    super(`Unknown model: ${ref.provider}/${ref.modelId}`);
    this.name = "UnknownModelError";
  }
}

export class AmbiguousModelError extends Error {
  constructor(
    public readonly selector: string,
    public readonly candidates: ModelRef[],
  ) {
    super(`Ambiguous model: ${selector}; qualify one of: ${candidates.map(formatModelRef).join(", ")}`);
    this.name = "AmbiguousModelError";
  }
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.modelId}`;
}

export function findModel(ref: ModelRef): ModelCard | undefined {
  return lookup.get(ref.provider)?.get(ref.modelId);
}

export function resolveModel(ref: ModelRef): ModelCard {
  const model = findModel(ref);
  if (!model) throw new UnknownModelError(ref);
  return model;
}

export function listModels(provider?: ProviderName): ModelCard[] {
  return provider
    ? Object.values(MODEL_CATALOG[provider])
    : providers.flatMap((name) => Object.values(MODEL_CATALOG[name]));
}

export function sameModelRef(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.provider === b.provider && a.modelId === b.modelId);
}

export function resolveModelSelector(selector: string, available: readonly ModelCard[] = listModels()): ModelCard {
  const slash = selector.indexOf("/");
  if (slash > 0) {
    const provider = selector.slice(0, slash);
    if (providers.includes(provider as ProviderName)) {
      return resolveModel({ provider: provider as ProviderName, modelId: selector.slice(slash + 1) });
    }
  }
  const matches = available.filter((model) => model.modelId === selector || model.aliases?.includes(selector));
  const unique = [...new Map(matches.map((model) => [formatModelRef(model), model])).values()];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) throw new AmbiguousModelError(selector, unique);
  throw new Error(`Unknown model: ${selector}`);
}

/** Map all known models to the protocol-facing ModelInfo shape. */
export function getModelInfoList(): ModelInfo[] {
  return listModels().map((model) => ({
    modelId: model.modelId,
    display: model.display,
    provider: model.provider,
    aliases: model.aliases,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    inputCostPer1M: model.inputCostPer1M,
    outputCostPer1M: model.outputCostPer1M,
    supportsThinking: model.supportsThinking,
    supportedEfforts: model.supportedEfforts,
    supportsVision: model.supportsVision,
  }));
}
