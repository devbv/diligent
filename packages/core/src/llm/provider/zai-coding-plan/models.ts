// @summary Z.AI Coding Plan-owned model-card definitions
import { defineProviderModels } from "../../model-card";
import { defineProviderModelClasses } from "../../model-class";

export const ZAI_CODING_PLAN_MODEL_CLASSES = defineProviderModelClasses({
  pro: { defaultModelId: "glm-5.2" },
  general: { defaultModelId: "glm-5.1" },
});

export const ZAI_CODING_PLAN_MODELS = defineProviderModels("zai-coding-plan", [
  {
    modelId: "glm-5.2",
    display: "GLM 5.2",
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
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    supportsThinking: false,
    supportsVision: false,
    aliases: ["glm5.1"],
  },
]);
