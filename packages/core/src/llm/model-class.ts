// @summary Shared model-class identifiers and provider definition helpers
export const MODEL_CLASS_IDS = ["pro", "general", "lite"] as const;

/** Abstract capability levels used to select a provider-specific concrete model. */
export type ModelClass = (typeof MODEL_CLASS_IDS)[number];

/** One provider's model selection definition for a supported capability class. */
export interface ProviderModelClassDefinition {
  defaultModelId: string;
  additionalModelIds?: readonly string[];
}

export type ProviderModelClassDefinitions = Partial<Readonly<Record<ModelClass, ProviderModelClassDefinition>>>;

export function defineProviderModelClasses(definitions: ProviderModelClassDefinitions): ProviderModelClassDefinitions {
  return definitions;
}
