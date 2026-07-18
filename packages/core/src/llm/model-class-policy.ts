// @summary Aggregates provider-owned pro, general, and lite model selection definitions
import { MODEL_CLASS_IDS, type ModelClass, type ProviderModelClassDefinitions } from "./model-class";
import { resolveModel } from "./models";
import { ANTHROPIC_MODEL_CLASSES } from "./provider/anthropic/models";
import { CHATGPT_MODEL_CLASSES } from "./provider/chatgpt/models";
import { GEMINI_MODEL_CLASSES } from "./provider/gemini/models";
import { OPENAI_MODEL_CLASSES } from "./provider/openai/models";
import { VERTEX_MODEL_CLASSES } from "./provider/vertex/models";
import { ZAI_CODING_PLAN_MODEL_CLASSES } from "./provider/zai-coding-plan/models";
import type { Model, ProviderName, ThinkingEffort } from "./types";

export type { ModelClass } from "./model-class";

export interface ModelClassDefinition {
  id: ModelClass;
  defaultEffort: ThinkingEffort;
  defaultModelIds: Partial<Readonly<Record<ProviderName, string>>>;
  additionalModelIds?: Partial<Readonly<Record<ProviderName, readonly string[]>>>;
}

const DEFAULT_EFFORT_BY_MODEL_CLASS: Readonly<Record<ModelClass, ThinkingEffort>> = {
  pro: "high",
  general: "medium",
  lite: "low",
};

const PROVIDER_MODEL_CLASSES = {
  anthropic: ANTHROPIC_MODEL_CLASSES,
  openai: OPENAI_MODEL_CLASSES,
  chatgpt: CHATGPT_MODEL_CLASSES,
  gemini: GEMINI_MODEL_CLASSES,
  vertex: VERTEX_MODEL_CLASSES,
  "zai-coding-plan": ZAI_CODING_PLAN_MODEL_CLASSES,
} satisfies Record<ProviderName, ProviderModelClassDefinitions>;

/**
 * Aggregated compatibility view. New mappings belong in the provider's
 * `models.ts` file.
 */
export const MODEL_CLASSES: readonly ModelClassDefinition[] = MODEL_CLASS_IDS.map((id) => {
  const defaultModelIds: Partial<Record<ProviderName, string>> = {};
  const additionalModelIds: Partial<Record<ProviderName, string[]>> = {};

  for (const provider of Object.keys(PROVIDER_MODEL_CLASSES) as ProviderName[]) {
    const definition = PROVIDER_MODEL_CLASSES[provider][id];
    if (!definition) continue;
    defaultModelIds[provider] = definition.defaultModelId;
    if (definition.additionalModelIds) {
      additionalModelIds[provider] = [...definition.additionalModelIds];
    }
  }

  return {
    id,
    defaultEffort: DEFAULT_EFFORT_BY_MODEL_CLASS[id],
    defaultModelIds,
    ...(Object.keys(additionalModelIds).length > 0 ? { additionalModelIds } : {}),
  };
});

const MODEL_CLASS_BY_ID = new Map(MODEL_CLASSES.map((modelClass) => [modelClass.id, modelClass]));
const modelClassKey = (provider: ProviderName, modelId: string): string => `${provider}\0${modelId}`;
const MODEL_CLASS_BY_MODEL_REF = new Map<string, ModelClass>();
for (const modelClass of MODEL_CLASSES) {
  for (const [provider, modelId] of Object.entries(modelClass.defaultModelIds)) {
    if (modelId) MODEL_CLASS_BY_MODEL_REF.set(modelClassKey(provider as ProviderName, modelId), modelClass.id);
  }
  for (const [provider, modelIds] of Object.entries(modelClass.additionalModelIds ?? {})) {
    for (const modelId of modelIds ?? []) {
      MODEL_CLASS_BY_MODEL_REF.set(modelClassKey(provider as ProviderName, modelId), modelClass.id);
    }
  }
}

/** Resolve a provider's concrete default for a class, or preserve the current model if unsupported. */
export function resolveModelForClass(currentModel: Model, targetClass: ModelClass): Model {
  const targetModelId = MODEL_CLASS_BY_ID.get(targetClass)?.defaultModelIds[currentModel.provider];
  if (targetModelId === undefined || targetModelId === currentModel.modelId) return currentModel;

  return resolveModel({ provider: currentModel.provider, modelId: targetModelId });
}

/** Determine class membership from class policy; unclassified concrete models default to general. */
export function getModelClass(model: Model): ModelClass {
  return MODEL_CLASS_BY_MODEL_REF.get(modelClassKey(model.provider, model.modelId)) ?? "general";
}

/** Return the default thinking effort associated with a model class. */
export function getDefaultEffortForClass(modelClass: ModelClass): ThinkingEffort {
  return MODEL_CLASS_BY_ID.get(modelClass)?.defaultEffort ?? "medium";
}
