// @summary Provider-specific pro, general, and lite model selection policy
import { resolveModel } from "./models";
import type { Model, ProviderName, ThinkingEffort } from "./types";

/** Abstract capability levels used to select a provider-specific concrete model. */
export type ModelClass = "pro" | "general" | "lite";

export interface ModelClassDefinition {
  id: ModelClass;
  defaultEffort: ThinkingEffort;
  defaultModelIds: Partial<Readonly<Record<ProviderName, string>>>;
  additionalModelIds?: Partial<Readonly<Record<ProviderName, readonly string[]>>>;
}

/**
 * The only three model classes. Each provider may have one concrete default per
 * class, while additional selectable models can retain class membership without
 * carrying policy data on their model cards.
 */
export const MODEL_CLASSES: readonly ModelClassDefinition[] = [
  {
    id: "pro",
    defaultEffort: "high",
    defaultModelIds: {
      anthropic: "claude-opus-4-8",
      gemini: "gemini-3.1-pro-preview",
      "zai-coding-plan": "glm-5.2",
      openai: "gpt-5.5",
      chatgpt: "gpt-5.5",
    },
    additionalModelIds: { openai: ["gpt-5.6-sol"], chatgpt: ["gpt-5.6-sol"] },
  },
  {
    id: "general",
    defaultEffort: "medium",
    defaultModelIds: {
      anthropic: "claude-sonnet-4-6",
      gemini: "gemini-3.5-flash",
      vertex: "vertex-gemma-4-26b-it",
      "zai-coding-plan": "glm-5.1",
      openai: "gpt-5.6-terra",
      chatgpt: "gpt-5.6-terra",
    },
    additionalModelIds: { anthropic: ["claude-sonnet-5"] },
  },
  {
    id: "lite",
    defaultEffort: "low",
    defaultModelIds: {
      anthropic: "claude-haiku-4-5-20251001",
      gemini: "gemini-3.1-flash-lite",
      openai: "gpt-5.6-luna",
      chatgpt: "gpt-5.6-luna",
    },
  },
];

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
