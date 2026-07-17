// @summary Shared model-card types and helpers for provider-owned model definitions
import type { Model, ProviderName, ThinkingEffort } from "./types";

export const MODEL_CARD_SCHEMA_VERSION = 1 as const;

export interface ModelCardProvenance {
  source: string;
  sourceUrl?: string;
  updatedAt?: string;
}

export interface ModelCard extends Model {
  schemaVersion: typeof MODEL_CARD_SCHEMA_VERSION;
  aliases?: string[];
  accessLevel?: string;
  display?: string;
  description?: string;
  ownedBy?: string;
  releasedAt?: string;
  knowledgeCutoff?: string;
  tags?: string[];
  provenance?: ModelCardProvenance;
  extensions?: Record<string, unknown>;
}

export type ProviderModelCardInput = Omit<ModelCard, "provider" | "schemaVersion">;

export const NATIVE_PROVIDER_THINKING_EFFORTS: ThinkingEffort[] = ["low", "medium", "high", "xhigh", "max"];
export const GPT_5_5_THINKING_EFFORTS: ThinkingEffort[] = ["low", "medium", "high", "xhigh"];

export function defineProviderModels(provider: ProviderName, cards: ProviderModelCardInput[]): ModelCard[] {
  return cards.map((card) => ({
    schemaVersion: MODEL_CARD_SCHEMA_VERSION,
    provider,
    ...card,
  }));
}
