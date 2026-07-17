// @summary Shared thinking-effort helpers for aliases, provider capabilities, and UI labels

import { sameModelRef } from "./models";
import type { Model, ModelInfo, ModelRef, ThinkingEffort } from "./types";

export const THINKING_EFFORT_VALUES = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingEffort[];

const FALLBACK_THINKING_EFFORT_VALUES: readonly ThinkingEffort[] = THINKING_EFFORT_VALUES.filter(
  (effort) => effort !== "xhigh",
);

export function supportsThinkingEffort(
  model: Pick<Model, "supportsThinking" | "supportedEfforts"> | undefined,
  effort: ThinkingEffort,
): boolean {
  if (!model?.supportsThinking) return false;
  return model.supportedEfforts?.includes(effort) ?? FALLBACK_THINKING_EFFORT_VALUES.includes(effort);
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
    label: effort,
  }));
}

export function normalizeThinkingEffort(
  model: Pick<Model, "provider" | "supportsThinking" | "supportedEfforts"> | undefined,
  effort: ThinkingEffort,
): ThinkingEffort {
  if (!model) return effort;
  if (!model.supportsThinking) {
    return effort === "xhigh" ? "medium" : effort;
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

export function findModelInfo(models: ModelInfo[], ref?: ModelRef): ModelInfo | undefined {
  if (!ref) return undefined;
  return models.find((model) => sameModelRef(model, ref));
}
