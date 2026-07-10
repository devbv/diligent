// @summary Shared thinking-effort helpers for aliases, provider capabilities, and UI labels
import type { Model, ModelInfo, ThinkingEffort } from "./types";

export const THINKING_EFFORT_VALUES = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingEffort[];

const FALLBACK_THINKING_EFFORT_VALUES: readonly ThinkingEffort[] = THINKING_EFFORT_VALUES.filter(
  (effort) => effort !== "none" && effort !== "xhigh",
);

export function supportsThinkingEffort(
  model: Pick<Model, "supportsThinking" | "supportedEfforts"> | undefined,
  effort: ThinkingEffort,
): boolean {
  if (!model?.supportsThinking) return false;
  return model.supportedEfforts?.includes(effort) ?? FALLBACK_THINKING_EFFORT_VALUES.includes(effort);
}

export function supportsThinkingNone(
  model: Pick<Model, "provider" | "supportsThinking" | "supportedEfforts"> | undefined,
): boolean {
  if (!model?.supportsThinking) return false;
  return model.supportedEfforts?.includes("none") ?? false;
}

export function getThinkingEffortLabel(
  effort: ThinkingEffort,
  model: Pick<Model, "provider" | "supportsThinking" | "supportedEfforts"> | undefined,
): string {
  if (effort === "none" && supportsThinkingNone(model)) return "minimal";
  return effort;
}

export function getThinkingEffortOptions(
  model: Pick<Model, "provider" | "supportsThinking" | "supportedEfforts"> | undefined,
): Array<{ value: ThinkingEffort; label: string }> {
  if (model && !model.supportsThinking) return [];
  const supportedEfforts =
    model?.supportsThinking === true
      ? (model.supportedEfforts ?? FALLBACK_THINKING_EFFORT_VALUES)
      : FALLBACK_THINKING_EFFORT_VALUES;
  return supportedEfforts.map((effort) => ({
    value: effort,
    label: getThinkingEffortLabel(effort, model),
  }));
}

export function normalizeThinkingEffort(
  model: Pick<Model, "provider" | "supportsThinking" | "supportedEfforts"> | undefined,
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

export function getThinkingEffortUsageValues(
  model: Pick<Model, "provider" | "supportsThinking" | "supportedEfforts"> | undefined,
): string[] {
  return getThinkingEffortOptions(model).map((option) => option.label);
}

export function getThinkingEffortUsage(
  model: Pick<Model, "provider" | "supportsThinking" | "supportedEfforts"> | undefined,
): string {
  return getThinkingEffortUsageValues(model).join("|");
}

export function findModelInfo(models: ModelInfo[], modelId?: string): ModelInfo | undefined {
  if (!modelId) return undefined;
  return models.find((model) => model.id === modelId);
}
