// @summary Model selection command - allows switching between available LLM models
import { getThinkingEffortLabel, MODEL_CARDS, normalizeThinkingEffort, resolveModel } from "@diligent/runtime";
import { DEFAULT_PROVIDER, PROVIDER_DESCRIPTORS, PROVIDER_NAMES, type ProviderName } from "../../../provider-manager";
import type { ListPickerItem } from "../../components/list-picker";
import { t } from "../../theme";
import type { Command } from "../types";
import { promptApiKey } from "./provider";

function providerDisplayName(provider: ProviderName): string {
  return PROVIDER_DESCRIPTORS[provider].displayName;
}

export const modelCommand: Command = {
  name: "model",
  description: "Switch model or show picker",
  supportsArgs: true,
  handler: async (args, ctx) => {
    if (args) {
      try {
        const model = resolveModel(args);
        const provider = (model.provider ?? DEFAULT_PROVIDER) as ProviderName;

        // Check if provider has API key
        if (!ctx.config.providerManager.hasKeyFor(provider)) {
          ctx.displayLines([`  ${t.warn}No API key for ${providerDisplayName(provider)}. Please enter one:${t.reset}`]);
          await promptApiKey(provider, ctx);
          // After key input, check again
          if (!ctx.config.providerManager.hasKeyFor(provider)) {
            ctx.displayError("Model switch cancelled — no API key provided.");
            return;
          }
        }

        ctx.config.model = model;
        await ctx.setModel(model.id);
        ctx.onModelChanged(model.id);
        const normalizedEffort = normalizeThinkingEffort(model, ctx.currentEffort);
        if (normalizedEffort !== ctx.currentEffort) {
          await ctx.setEffort(normalizedEffort);
          ctx.onEffortChanged(normalizedEffort, getThinkingEffortLabel(normalizedEffort, model));
        }
        ctx.displayLines([`  Model switched to ${t.bold}${model.id}${t.reset}`]);
      } catch {
        ctx.displayError(`Unknown model: ${args}`);
      }
      return;
    }

    // Show picker with models grouped by authenticated provider.
    // If no provider is authenticated, fall back to current provider models.
    const currentModelId = ctx.config.model.id;
    const currentProvider = (ctx.config.model.provider ?? DEFAULT_PROVIDER) as ProviderName;
    const pm = ctx.config.providerManager;

    const authenticatedProviders = PROVIDER_NAMES.filter((provider) => pm.hasKeyFor(provider));
    const visibleProviders = authenticatedProviders.length > 0 ? authenticatedProviders : [currentProvider];

    // Sort visible providers: current provider first, then others
    const sortedProviders = [...visibleProviders].sort((a, b) => {
      const groupA = a === currentProvider ? 0 : 1;
      const groupB = b === currentProvider ? 0 : 1;
      return groupA - groupB;
    });

    // Build grouped items with section headers
    const items: ListPickerItem[] = [];
    for (const prov of sortedProviders) {
      const models = MODEL_CARDS.filter((m) => (m.provider ?? DEFAULT_PROVIDER) === prov);
      if (models.length === 0) continue;
      items.push({ label: providerDisplayName(prov), value: "", header: true });
      for (const m of models) {
        const aliases = m.aliases?.length ? m.aliases.join(", ") : "";
        items.push({ label: m.id, description: aliases, value: m.id });
      }
    }

    if (items.length === 0) {
      ctx.displayError("No models available for authenticated providers. Configure one via /provider set <name>.");
      return;
    }

    const selectedIdx = items.findIndex((i) => i.value === currentModelId);

    const value = await ctx.app.pick({ title: "Model", items, selectedIndex: Math.max(0, selectedIdx) });
    if (!value) {
      return;
    }
    const model = resolveModel(value);
    const provider = (model.provider ?? DEFAULT_PROVIDER) as ProviderName;

    if (!ctx.config.providerManager.hasKeyFor(provider)) {
      ctx.displayLines([`  ${t.warn}No API key for ${providerDisplayName(provider)}. Please enter one:${t.reset}`]);
      await promptApiKey(provider, ctx);
      if (!ctx.config.providerManager.hasKeyFor(provider)) {
        ctx.displayError("Model switch cancelled — no API key provided.");
        return;
      }
    }

    ctx.config.model = model;
    await ctx.setModel(model.id);
    ctx.onModelChanged(model.id);
    const normalizedEffort = normalizeThinkingEffort(model, ctx.currentEffort);
    if (normalizedEffort !== ctx.currentEffort) {
      await ctx.setEffort(normalizedEffort);
      ctx.onEffortChanged(normalizedEffort, getThinkingEffortLabel(normalizedEffort, model));
    }
    ctx.displayLines([`  Model switched to ${t.bold}${model.id}${t.reset}`]);
  },
};
