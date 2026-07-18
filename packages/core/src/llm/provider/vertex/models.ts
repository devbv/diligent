// @summary Vertex-owned model-card definitions
import { defineProviderModels } from "../../model-card";
import { defineProviderModelClasses } from "../../model-class";

export const VERTEX_MODEL_CLASSES = defineProviderModelClasses({
  general: { defaultModelId: "vertex-gemma-4-26b-it" },
});

export const VERTEX_MODELS = defineProviderModels("vertex", [
  {
    modelId: "vertex-gemma-4-26b-it",
    display: "Gemma 4 26B (Vertex)",
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    supportsThinking: false,
    aliases: ["vertex-gemma", "vertex-gemma-4", "vertex-gemma-4-26b", "gemma-4-26b-vertex", "gemma-vertex"],
  },
]);
