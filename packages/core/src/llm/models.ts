// @summary Provider-composed model catalog with identity validation and resolution

import type { ModelCard } from "./model-card";
import { ANTHROPIC_MODELS } from "./provider/anthropic/models";
import { CHATGPT_MODELS } from "./provider/chatgpt/models";
import { GEMINI_MODELS } from "./provider/gemini/models";
import { OPENAI_MODELS } from "./provider/openai/models";
import { VERTEX_MODELS } from "./provider/vertex/models";
import { ZAI_CODING_PLAN_MODELS } from "./provider/zai-coding-plan/models";
import type { ModelInfo, ModelRef, ProviderName } from "./types";

export type { ModelCard, ModelCardProvenance } from "./model-card";
export { MODEL_CARD_SCHEMA_VERSION } from "./model-card";

const PROVIDER_MODELS = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  chatgpt: CHATGPT_MODELS,
  gemini: GEMINI_MODELS,
  vertex: VERTEX_MODELS,
  "zai-coding-plan": ZAI_CODING_PLAN_MODELS,
} satisfies Record<ProviderName, readonly ModelCard[]>;

const providers = ["anthropic", "openai", "chatgpt", "gemini", "vertex", "zai-coding-plan"] as const;
const catalog = Object.fromEntries(providers.map((provider) => [provider, {}])) as Record<
  ProviderName,
  Record<string, ModelCard>
>;
const lookup = new Map<ProviderName, Map<string, ModelCard>>(providers.map((provider) => [provider, new Map()]));

for (const provider of providers) {
  for (const card of PROVIDER_MODELS[provider]) {
    if (card.provider !== provider) {
      throw new Error(`Provider model ownership mismatch: ${provider}/${card.provider}/${card.modelId}`);
    }
    const providerLookup = lookup.get(provider);
    if (!providerLookup) throw new Error(`Unsupported model provider: ${provider}`);
    if (providerLookup.has(card.modelId)) throw new Error(`Duplicate model identity: ${provider}/${card.modelId}`);
    catalog[provider][card.modelId] = card;
    providerLookup.set(card.modelId, card);
    for (const alias of card.aliases ?? []) {
      if (providerLookup.has(alias)) throw new Error(`Duplicate model alias: ${provider}/${alias}`);
      providerLookup.set(alias, card);
    }
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
