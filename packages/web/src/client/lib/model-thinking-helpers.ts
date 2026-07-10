// @summary Web model lookup and thinking-effort option helpers

import type { ModelInfo, ThinkingEffort } from "@diligent/protocol";

export function findModelInfo(models: ModelInfo[], modelId?: string): ModelInfo | undefined {
  if (!modelId) return undefined;
  return models.find((model) => model.id === modelId);
}

export function supportsThinkingNone(
  model: Pick<ModelInfo, "supportsThinking" | "supportedEfforts"> | undefined,
): boolean {
  if (!model?.supportsThinking) return false;
  return model.supportedEfforts?.includes("none") ?? false;
}

export function supportsThinkingEffort(
  model: Pick<ModelInfo, "supportsThinking" | "supportedEfforts"> | undefined,
  effort: ThinkingEffort,
): boolean {
  if (!model?.supportsThinking) return false;
  return model.supportedEfforts?.includes(effort) ?? !["none", "xhigh"].includes(effort);
}

function getThinkingEffortLabel(
  effort: ThinkingEffort,
  model: Pick<ModelInfo, "supportsThinking" | "supportedEfforts"> | undefined,
): string {
  if (effort === "none" && supportsThinkingNone(model)) return "minimal";
  return effort;
}

export function getThinkingEffortOptions(
  model: Pick<ModelInfo, "supportsThinking" | "supportedEfforts"> | undefined,
): Array<{ value: ThinkingEffort; label: string }> {
  const fallbackEffortValues: ThinkingEffort[] = ["low", "medium", "high", "max"];
  if (model && !model.supportsThinking) return [];
  const supportedEfforts =
    model?.supportsThinking === true ? (model.supportedEfforts ?? fallbackEffortValues) : fallbackEffortValues;
  return supportedEfforts.map((effort) => ({ value: effort, label: getThinkingEffortLabel(effort, model) }));
}

export function normalizeThinkingEffort(
  model: Pick<ModelInfo, "provider" | "supportsThinking" | "supportedEfforts"> | undefined,
  effort: ThinkingEffort,
): ThinkingEffort {
  if (!model) return effort;
  if (!model.supportsThinking) {
    return effort === "none" || effort === "xhigh" ? "medium" : effort;
  }
  if (supportsThinkingEffort(model, effort)) return effort;
  if (
    effort === "xhigh" &&
    (model.provider === "openai" || model.provider === "chatgpt") &&
    supportsThinkingEffort(model, "max")
  ) {
    return "max";
  }
  if (supportsThinkingEffort(model, "medium")) return "medium";
  return getThinkingEffortOptions(model)[0]?.value ?? effort;
}

export function getThinkingEffortUsage(
  model: Pick<ModelInfo, "supportsThinking" | "supportedEfforts"> | undefined,
): string {
  return getThinkingEffortOptions(model)
    .map((option) => option.label)
    .join("|");
}
