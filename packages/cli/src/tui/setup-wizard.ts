// @summary Factory for first-run provider selection and API key setup wizard
import { resolveModel } from "@diligent/runtime";
import type { AppConfig } from "../config";
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  PROVIDER_DESCRIPTORS,
  PROVIDER_NAMES,
  type ProviderName,
} from "../provider-manager";
import { promptApiKey, promptSaveKey } from "./commands/builtin/provider";
import type { CommandContext } from "./commands/types";
import type { ListPickerItem } from "./components/list-picker";
import { t } from "./theme";

export interface SetupWizardDeps {
  config: AppConfig;
  addLines: (lines: string[]) => void;
  requestRender: () => void;
  buildCommandContext: () => CommandContext;
  updateStatusBar: (updates: Record<string, unknown>) => void;
}

export interface SetupWizard {
  runSetupWizard: () => Promise<void>;
}

export function createSetupWizard(deps: SetupWizardDeps): SetupWizard {
  function wizardPickProvider(): Promise<ProviderName | null> {
    const ctx = deps.buildCommandContext();
    const items: ListPickerItem[] = PROVIDER_NAMES.map((p) => ({
      label: PROVIDER_DESCRIPTORS[p].displayName,
      description: deps.config.providerManager.hasKeyFor(p) ? "configured" : "no key",
      value: p,
    }));
    return ctx.app.pick({ title: "Select Provider", items }) as Promise<ProviderName | null>;
  }

  function wizardEnterApiKey(provider: ProviderName): Promise<string | null> {
    if (provider === "chatgpt") return Promise.resolve(null);
    const ctx = deps.buildCommandContext();
    const { apiKeyUrl: hint, apiKeyPlaceholder: placeholder } = PROVIDER_DESCRIPTORS[provider];
    return ctx.app.prompt({
      title: `${PROVIDER_DESCRIPTORS[provider].displayName} API Key`,
      message: `Enter your ${PROVIDER_DESCRIPTORS[provider].displayName} API key (${hint})`,
      placeholder,
      masked: true,
    });
  }

  return {
    async runSetupWizard(): Promise<void> {
      deps.addLines([
        "",
        `  ${t.warn}No AI connection found.${t.reset} Let's set it up together.`,
        `  ${t.dim}Tip: ChatGPT is the easiest first option for most users (browser login, no API key).${t.reset}`,
        "",
      ]);
      deps.requestRender();

      // Step 1: Pick provider
      const provider = await wizardPickProvider();
      if (!provider) {
        deps.addLines([
          `  ${t.dim}Setup skipped. Run /provider set chatgpt anytime for the fastest setup.${t.reset}`,
          "",
        ]);
        deps.requestRender();
        return;
      }

      // Step 2: Enter API key
      if (provider === "chatgpt") {
        const ctx = deps.buildCommandContext();
        await promptApiKey("chatgpt", ctx);
        if (!deps.config.providerManager.hasKeyFor("chatgpt")) {
          deps.addLines([`  ${t.dim}Setup paused. Run /provider set chatgpt when you're ready.${t.reset}`, ""]);
          deps.requestRender();
          return;
        }
      } else {
        const apiKey = await wizardEnterApiKey(provider);
        if (!apiKey) {
          deps.addLines([`  ${t.dim}Setup paused. Run /provider set ${provider} when you're ready.${t.reset}`, ""]);
          deps.requestRender();
          return;
        }

        deps.config.providerManager.setApiKey(provider, apiKey);

        const ctx = deps.buildCommandContext();
        await promptSaveKey(provider, apiKey, ctx);
      }

      // Switch model if the selected provider differs from current
      const currentProvider = deps.config.model.provider ?? DEFAULT_PROVIDER;
      if (currentProvider !== provider) {
        const defaultModelId = DEFAULT_MODELS[provider];
        deps.config.model = resolveModel(defaultModelId);
        deps.updateStatusBar({ model: deps.config.model.id });
      }

      deps.addLines([`  ${t.success}Ready!${t.reset} Using ${t.bold}${deps.config.model.id}${t.reset}`, ""]);
      deps.requestRender();
    },
  };
}
