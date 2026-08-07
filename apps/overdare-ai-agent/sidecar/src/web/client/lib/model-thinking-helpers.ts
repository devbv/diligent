// @summary Web model lookup and thinking-effort option helpers

import type { ModelInfo, ModelRef, ThinkingEffort } from "@diligent/protocol";

const DEFAULT_THINKING_EFFORT_VALUES = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingEffort[];

const THINKING_EFFORT_LABELS: Record<ThinkingEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export function formatThinkingEffortLabel(effort: ThinkingEffort): string {
  return THINKING_EFFORT_LABELS[effort] ?? effort;
}

export function sameModelRef(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.provider === b.provider && a.modelId === b.modelId);
}

export function modelOptionKey(model: ModelRef): string {
  return `${model.provider}\0${model.modelId}`;
}

export function resolveModelSelector(models: ModelInfo[], selector: string): ModelInfo {
  const slash = selector.indexOf("/");
  const scoped = slash > 0 ? models.filter((model) => model.provider === selector.slice(0, slash)) : models;
  const value = slash > 0 ? selector.slice(slash + 1) : selector;
  const matches = scoped.filter((model) => model.modelId === value || model.aliases?.includes(value));
  const unique = [...new Map(matches.map((model) => [modelOptionKey(model), model])).values()];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) {
    throw new Error(
      `Ambiguous model: ${selector}; qualify one of: ${unique.map((model) => `${model.provider}/${model.modelId}`).join(", ")}`,
    );
  }
  throw new Error(`Unknown model: ${selector}`);
}

export function findModelInfo(models: ModelInfo[], ref?: ModelRef): ModelInfo | undefined {
  if (!ref) return undefined;
  return models.find((model) => sameModelRef(model, ref));
}

export function supportsThinkingEffort(
  model: Pick<ModelInfo, "supportsThinking" | "supportedEfforts"> | undefined,
  effort: ThinkingEffort,
): boolean {
  if (!model?.supportsThinking) return false;
  return model.supportedEfforts?.includes(effort) ?? DEFAULT_THINKING_EFFORT_VALUES.includes(effort);
}

export function getThinkingEffortOptions(
  model: Pick<ModelInfo, "supportsThinking" | "supportedEfforts"> | undefined,
): Array<{ value: ThinkingEffort; label: string }> {
  if (model && !model.supportsThinking) return [];
  const supportedEfforts =
    model?.supportsThinking === true
      ? (model.supportedEfforts ?? DEFAULT_THINKING_EFFORT_VALUES)
      : DEFAULT_THINKING_EFFORT_VALUES;
  return supportedEfforts.map((effort) => ({ value: effort, label: formatThinkingEffortLabel(effort) }));
}

export function normalizeThinkingEffort(
  model: Pick<ModelInfo, "supportsThinking" | "supportedEfforts"> | undefined,
  effort: ThinkingEffort,
): ThinkingEffort {
  if (!model || !model.supportsThinking) return effort;
  if (supportsThinkingEffort(model, effort)) return effort;
  if (supportsThinkingEffort(model, "medium")) return "medium";
  return getThinkingEffortOptions(model)[0]?.value ?? effort;
}

export function getThinkingEffortUsage(
  model: Pick<ModelInfo, "supportsThinking" | "supportedEfforts"> | undefined,
): string {
  // Usage hints echo the literal `/effort` argument values, not the menu display labels.
  return getThinkingEffortOptions(model)
    .map((option) => option.value)
    .join("|");
}
