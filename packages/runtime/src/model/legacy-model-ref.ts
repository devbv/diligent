// @summary Normalizes persisted pre-P082 scalar model IDs into strict provider-scoped references
import { listModels } from "@diligent/core/model-registry";
import type { ModelRef, ProviderName } from "@diligent/core/provider-contract";
import { ProviderNameSchema } from "@diligent/protocol";

const LEGACY_CHATGPT_PREFIX = "chatgpt-";

export function normalizeLegacyModelRef(value: unknown, providerHint?: ProviderName): ModelRef {
  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<ModelRef>;
    const provider = ProviderNameSchema.safeParse(candidate.provider);
    if (provider.success && typeof candidate.modelId === "string" && candidate.modelId.length > 0) {
      return { provider: provider.data, modelId: candidate.modelId };
    }
  }
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid persisted model selection");

  if (value.startsWith(LEGACY_CHATGPT_PREFIX)) {
    return { provider: "chatgpt", modelId: `gpt-${value.slice(LEGACY_CHATGPT_PREFIX.length)}` };
  }
  if (providerHint) {
    return { provider: providerHint, modelId: value };
  }

  if (value.startsWith("claude-")) return { provider: "anthropic", modelId: value };
  if (value.startsWith("gpt-") || /^o[1-9]/.test(value)) return { provider: "openai", modelId: value };
  if (value.startsWith("gemini-")) return { provider: "gemini", modelId: value };
  if (value.startsWith("vertex-")) return { provider: "vertex", modelId: value };
  if (value.startsWith("glm-")) return { provider: "zai-coding-plan", modelId: value };

  const matches = listModels().filter((model) => model.modelId === value || model.aliases?.includes(value));
  const unique = new Map(matches.map((model) => [`${model.provider}/${model.modelId}`, model]));
  if (unique.size === 1) {
    const model = [...unique.values()][0];
    return { provider: model.provider, modelId: model.modelId };
  }

  // The pre-P082 resolver used Anthropic as its final fallback. Preserve only that
  // historical identity here so retired cards remain readable; no capabilities are created.
  return { provider: "anthropic", modelId: value };
}
