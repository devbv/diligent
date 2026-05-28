// @summary In-process product-owned tool provider contract for bundled runtime tools

import type { Tool } from "@diligent/core/tool/types";
import type { PluginHookFn } from "../hooks/runner";
import type { RuntimeToolHost } from "./capabilities";

export interface BundledToolProviderContext {
  cwd: string;
  host?: RuntimeToolHost;
}

export interface BundledToolProvider {
  id: string;
  displayName?: string;
  supersedesPluginPackages?: string[];
  createTools(ctx: BundledToolProviderContext): Promise<Tool[]> | Tool[];
  onUserPromptSubmit?: PluginHookFn;
  onStop?: PluginHookFn;
}

export interface CollectedBundledHooks {
  onUserPromptSubmit: PluginHookFn[];
  onStop: PluginHookFn[];
}

export function collectBundledHooks(providers: BundledToolProvider[] = []): CollectedBundledHooks {
  const hooks: CollectedBundledHooks = { onUserPromptSubmit: [], onStop: [] };

  for (const provider of providers) {
    if (provider.onUserPromptSubmit) hooks.onUserPromptSubmit.push(provider.onUserPromptSubmit);
    if (provider.onStop) hooks.onStop.push(provider.onStop);
  }

  return hooks;
}
