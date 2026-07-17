// @summary In-process product-owned tool provider contract for bundled runtime tools

import type { AgentLoopHook } from "@diligent/core/agent";
import type { Model } from "@diligent/core/provider-contract";
import type { Tool } from "@diligent/core/tool-contract";
import type { Logger } from "@diligent/logging";
import type { PluginHookFn } from "../hooks/runner";
import type { RuntimeToolHost } from "./capabilities";

export interface BundledToolProviderContext {
  cwd: string;
  host?: RuntimeToolHost;
}

export interface AgentLoopHookFactoryContext {
  cwd: string;
  agentKind: "main" | "child";
  model: Model;
  tools: readonly Tool[];
  parentSessionId?: string;
  logger: Logger;
}

export type AgentLoopHookFactory = (context: AgentLoopHookFactoryContext) => readonly AgentLoopHook[];

export interface BundledToolProvider {
  id: string;
  displayName?: string;
  supersedesPluginPackages?: string[];
  createTools(ctx: BundledToolProviderContext): Promise<Tool[]> | Tool[];
  onUserPromptSubmit?: PluginHookFn;
  onStop?: PluginHookFn;
  /**
   * Fired after each session entry is durably appended (hook_event_name "EntryAppended").
   * Use `mode: "async"` for fire-and-forget side-effects (e.g. gateway transmission) — the
   * runner detaches async hooks so they never block the write/turn path. Cannot block a write.
   */
  onEntryAppended?: PluginHookFn;
  createAgentLoopHooks?: AgentLoopHookFactory;
}

export function createBundledAgentLoopHooks(
  providers: readonly BundledToolProvider[] = [],
  context: AgentLoopHookFactoryContext,
): AgentLoopHook[] {
  return providers.flatMap((provider) => provider.createAgentLoopHooks?.(context) ?? []);
}

export interface CollectedBundledHooks {
  onUserPromptSubmit: PluginHookFn[];
  onStop: PluginHookFn[];
  onEntryAppended: PluginHookFn[];
}

export function collectBundledHooks(providers: BundledToolProvider[] = []): CollectedBundledHooks {
  const hooks: CollectedBundledHooks = { onUserPromptSubmit: [], onStop: [], onEntryAppended: [] };

  for (const provider of providers) {
    if (provider.onUserPromptSubmit) hooks.onUserPromptSubmit.push(provider.onUserPromptSubmit);
    if (provider.onStop) hooks.onStop.push(provider.onStop);
    if (provider.onEntryAppended) hooks.onEntryAppended.push(provider.onEntryAppended);
  }

  return hooks;
}
