// @summary Provider-specific pro, general, and lite model selection policy
import { resolveModel } from "./models";
import type { Model, ThinkingEffort } from "./types";

/** Abstract capability levels used to select a provider-specific concrete model. */
export type ModelClass = "pro" | "general" | "lite";

export interface ModelClassDefinition {
  id: ModelClass;
  defaultEffort: ThinkingEffort;
  defaultModels: Readonly<Record<string, string>>;
  additionalModels?: readonly string[];
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
    defaultModels: {
      anthropic: "claude-opus-4-8",
      gemini: "gemini-3.1-pro-preview",
      "zai-coding-plan": "glm-5.2",
      openai: "gpt-5.5",
      chatgpt: "chatgpt-5.5",
    },
    additionalModels: ["gpt-5.6-sol", "chatgpt-5.6-sol"],
  },
  {
    id: "general",
    defaultEffort: "medium",
    defaultModels: {
      anthropic: "claude-sonnet-4-6",
      gemini: "gemini-3.5-flash",
      vertex: "vertex-gemma-4-26b-it",
      "zai-coding-plan": "glm-5.1",
      openai: "gpt-5.6-terra",
      chatgpt: "chatgpt-5.6-terra",
    },
    additionalModels: ["claude-sonnet-5"],
  },
  {
    id: "lite",
    defaultEffort: "low",
    defaultModels: {
      anthropic: "claude-haiku-4-5-20251001",
      gemini: "gemini-3.1-flash-lite",
      openai: "gpt-5.6-luna",
      chatgpt: "chatgpt-5.6-luna",
    },
  },
];

const MODEL_CLASS_BY_ID = new Map(MODEL_CLASSES.map((modelClass) => [modelClass.id, modelClass]));
const MODEL_CLASS_BY_MODEL_ID = new Map<string, ModelClass>(
  MODEL_CLASSES.flatMap((modelClass) =>
    [...Object.values(modelClass.defaultModels), ...(modelClass.additionalModels ?? [])].map(
      (modelId) => [modelId, modelClass.id] as const,
    ),
  ),
);

/** Resolve a provider's concrete default for a class, or preserve the current model if unsupported. */
export function resolveModelForClass(currentModel: Model, targetClass: ModelClass): Model {
  const targetModelId = MODEL_CLASS_BY_ID.get(targetClass)?.defaultModels[currentModel.provider];
  if (targetModelId === undefined || targetModelId === currentModel.id) return currentModel;

  const resolved = resolveModel(targetModelId);
  return resolved.provider === currentModel.provider ? resolved : currentModel;
}

/** Determine class membership from class policy; unclassified concrete models default to general. */
export function getModelClass(model: Model): ModelClass {
  return MODEL_CLASS_BY_MODEL_ID.get(model.id) ?? "general";
}

/** Return the default thinking effort associated with a model class. */
export function getDefaultEffortForClass(modelClass: ModelClass): ThinkingEffort {
  return MODEL_CLASS_BY_ID.get(modelClass)?.defaultEffort ?? "medium";
}
