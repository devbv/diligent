// @summary Tool catalog builder — phase-based pipeline that merges builtins and plugins with config toggles

import type { Tool } from "@diligent/core/tool/types";
import { COLLAB_TOOL_NAMES } from "../collab";
import type { DiligentConfig } from "../config/schema";
import type { BundledToolProvider } from "./bundled-provider";
import type { RuntimeToolHost } from "./capabilities";
import { withImageDownscaling } from "./image-resize";
import { isImmutableTool } from "./immutable";
import { discoverGlobalPlugins, loadPlugin } from "./plugin-loader";

export type ToolStateReason =
  | "enabled"
  | "disabled_by_user"
  | "immutable_forced_on"
  | "plugin_disabled"
  | "plugin_load_failed"
  | "conflict_dropped"
  | "invalid_plugin_tool"
  | "superseded_by_bundled";

export interface ToolStateEntry {
  name: string;
  source: "builtin" | "plugin";
  pluginPackage?: string;
  enabled: boolean;
  immutable: boolean;
  configurable: boolean;
  available: boolean;
  reason: ToolStateReason;
  error?: string;
}

export interface PluginStateEntry {
  package: string;
  configured: boolean;
  enabled: boolean;
  loaded: boolean;
  toolCount: number;
  loadError?: string;
  warnings: string[];
}

export interface PluginLoadError {
  package: string;
  enabled: boolean;
  error: string;
}

export interface ToolCatalogResult {
  /** Final enabled tools for agent loop */
  tools: Tool[];
  /** Full metadata for UI display */
  state: ToolStateEntry[];
  /** Plugin-level metadata for UI display */
  plugins: PluginStateEntry[];
  /** Plugin-level load errors retained for compatibility with existing callers */
  pluginErrors: PluginLoadError[];
}

export type ToolMapEntry = {
  tool: Tool;
  source: "builtin" | "plugin";
  pluginPackage?: string;
  order: number;
};

export interface BuildToolCatalogOptions {
  bundledProviders?: BundledToolProvider[];
}

export interface ProviderToolBatch {
  id: string;
  tools: Tool[];
  orderBase: number;
  toolToggles: Record<string, boolean>;
  label: "Bundled provider" | "Plugin";
}

export interface PluginConfig {
  package: string;
  enabled: boolean;
  tools?: Record<string, boolean>;
}

type ConflictPolicy = "error" | "builtin_wins" | "plugin_wins";

function compareEntries(a: ToolMapEntry, b: ToolMapEntry): number {
  return a.order - b.order || a.tool.name.localeCompare(b.tool.name);
}

// ---------------------------------------------------------------------------
// Phase 1: loadBuiltins
// ---------------------------------------------------------------------------

/**
 * Build the initial tool map and state from built-in tools.
 * Collab tools are excluded from the configurable catalog.
 */
export function loadBuiltins(
  builtinTools: Tool[],
  builtinToggles: Record<string, boolean>,
): { toolMap: Map<string, ToolMapEntry>; state: Map<string, ToolStateEntry> } {
  const toolMap = new Map<string, ToolMapEntry>();
  const state = new Map<string, ToolStateEntry>();
  let order = 0;

  for (const tool of builtinTools) {
    if (COLLAB_TOOL_NAMES.has(tool.name)) continue;

    const immutable = isImmutableTool(tool.name);
    const disabledByUser = builtinToggles[tool.name] === false;
    const enabled = immutable ? true : !disabledByUser;

    toolMap.set(tool.name, { tool, source: "builtin", order: order++ });
    state.set(tool.name, {
      name: tool.name,
      source: "builtin",
      enabled,
      immutable,
      configurable: !immutable,
      available: true,
      reason: immutable && disabledByUser ? "immutable_forced_on" : enabled ? "enabled" : "disabled_by_user",
    });
  }

  return { toolMap, state };
}

// ---------------------------------------------------------------------------
// Phase 2: loadBundledBatches
// ---------------------------------------------------------------------------

/**
 * Invoke each bundled provider's createTools() and collect tool batches.
 * Providers that throw are recorded as errors and skipped.
 */
export async function loadBundledBatches(
  bundledProviders: BundledToolProvider[],
  cwd: string,
  host: RuntimeToolHost | undefined,
  orderStart: number,
): Promise<{ batches: ProviderToolBatch[]; errors: PluginLoadError[] }> {
  const batches: ProviderToolBatch[] = [];
  const errors: PluginLoadError[] = [];

  for (const [providerIndex, provider] of bundledProviders.entries()) {
    let providerTools: Tool[];
    try {
      providerTools = await Promise.resolve(provider.createTools({ cwd, host }));
    } catch (err) {
      errors.push({
        package: provider.id,
        enabled: true,
        error: `Bundled provider '${provider.id}' createTools() threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    batches.push({
      id: provider.id,
      tools: providerTools,
      orderBase: orderStart + providerIndex * 1000,
      toolToggles: {},
      label: "Bundled provider",
    });
  }

  return { batches, errors };
}

// ---------------------------------------------------------------------------
// Phase 3: loadPluginBatches
// ---------------------------------------------------------------------------

/**
 * Load plugin tools for all configured plugins and collect tool batches.
 * Returns batches for enabled+loaded plugins, plus plugin-level state, errors,
 * and pre-resolved state entries for disabled/superseded/invalid tools.
 */
export async function loadPluginBatches(
  pluginConfigs: PluginConfig[],
  supersededPackages: Set<string>,
  cwd: string,
  host: RuntimeToolHost | undefined,
  orderStart: number,
): Promise<{
  batches: ProviderToolBatch[];
  plugins: PluginStateEntry[];
  errors: PluginLoadError[];
  deferredStateEntries: Array<[string, ToolStateEntry]>;
}> {
  const batches: ProviderToolBatch[] = [];
  const plugins: PluginStateEntry[] = [];
  const errors: PluginLoadError[] = [];
  const deferredStateEntries: Array<[string, ToolStateEntry]> = [];

  for (const [pluginIndex, pluginConfig] of pluginConfigs.entries()) {
    const pluginEnabled = pluginConfig.enabled ?? true;
    const pluginState: PluginStateEntry = {
      package: pluginConfig.package,
      configured: true,
      enabled: pluginEnabled,
      loaded: false,
      toolCount: 0,
      warnings: [],
    };
    plugins.push(pluginState);

    if (supersededPackages.has(pluginConfig.package)) {
      pluginState.loadError = `Plugin '${pluginConfig.package}' is superseded by a bundled tool provider.`;
      for (const toolName of Object.keys(pluginConfig.tools ?? {})) {
        deferredStateEntries.push([
          `superseded:${pluginConfig.package}:${toolName}`,
          {
            name: toolName,
            source: "plugin",
            pluginPackage: pluginConfig.package,
            enabled: false,
            immutable: false,
            configurable: true,
            available: false,
            reason: "superseded_by_bundled",
            error: pluginState.loadError,
          },
        ]);
      }
      errors.push({ package: pluginConfig.package, enabled: pluginEnabled, error: pluginState.loadError });
      continue;
    }

    if (!pluginEnabled) {
      const toolToggles = pluginConfig.tools ?? {};
      for (const toolName of Object.keys(toolToggles)) {
        if (toolToggles[toolName] === false) {
          deferredStateEntries.push([
            `plugin-disabled:${pluginConfig.package}:${toolName}`,
            {
              name: toolName,
              source: "plugin",
              pluginPackage: pluginConfig.package,
              enabled: false,
              immutable: false,
              configurable: true,
              available: false,
              reason: "plugin_disabled",
            },
          ]);
        }
      }
      continue;
    }

    const result = await loadPlugin(pluginConfig.package, cwd, host);
    pluginState.loaded = !result.error;
    pluginState.toolCount = result.tools.length;

    if (result.error) {
      pluginState.loadError = result.error;
      errors.push({ package: pluginConfig.package, enabled: true, error: result.error });
      for (const invalidTool of result.invalidTools ?? []) {
        deferredStateEntries.push([
          `invalid:${pluginConfig.package}:${invalidTool.name}`,
          {
            name: invalidTool.name,
            source: "plugin",
            pluginPackage: pluginConfig.package,
            enabled: false,
            immutable: false,
            configurable: true,
            available: false,
            reason: "invalid_plugin_tool",
            error: invalidTool.error,
          },
        ]);
      }
      continue;
    }

    pluginState.loaded = true;
    pluginState.warnings = result.warnings ?? [];
    if ((result.warnings?.length ?? 0) > 0) {
      for (const warning of result.warnings ?? []) {
        errors.push({ package: pluginConfig.package, enabled: true, error: warning });
      }
    }
    for (const invalidTool of result.invalidTools ?? []) {
      deferredStateEntries.push([
        `invalid:${pluginConfig.package}:${invalidTool.name}`,
        {
          name: invalidTool.name,
          source: "plugin",
          pluginPackage: pluginConfig.package,
          enabled: false,
          immutable: false,
          configurable: true,
          available: false,
          reason: "invalid_plugin_tool",
          error: invalidTool.error,
        },
      ]);
    }

    batches.push({
      id: pluginConfig.package,
      tools: result.tools,
      orderBase: orderStart + pluginIndex * 1000,
      toolToggles: pluginConfig.tools ?? {},
      label: "Plugin",
    });
  }

  return { batches, plugins, errors, deferredStateEntries };
}

// ---------------------------------------------------------------------------
// Phase 4: resolveConflicts
// ---------------------------------------------------------------------------

/**
 * Merge a provider tool batch into the catalog, applying conflict resolution policy.
 * Mutates toolMap, state, and pluginErrors in place.
 */
export function resolveConflicts(
  batches: ProviderToolBatch[],
  toolMap: Map<string, ToolMapEntry>,
  state: Map<string, ToolStateEntry>,
  pluginErrors: PluginLoadError[],
  conflictPolicy: ConflictPolicy,
): void {
  for (const batch of batches) {
    for (const [toolIndex, tool] of batch.tools.entries()) {
      const pluginOrder = batch.orderBase + toolIndex;
      const existing = toolMap.get(tool.name);

      if (existing && existing.source === "builtin") {
        const existingState = state.get(tool.name)!;
        const builtinImmutable = isImmutableTool(tool.name);

        if (builtinImmutable) {
          state.set(`conflict:${batch.id}:${tool.name}`, {
            name: tool.name,
            source: "plugin",
            pluginPackage: batch.id,
            enabled: false,
            immutable: false,
            configurable: true,
            available: false,
            reason: "conflict_dropped",
            error: `${batch.label} tool '${tool.name}' cannot override immutable built-in tool '${tool.name}'.`,
          });
          pluginErrors.push({
            package: batch.id,
            enabled: true,
            error: `${batch.label} tool '${tool.name}' cannot override immutable built-in tool '${tool.name}'.`,
          });
          continue;
        }

        if (conflictPolicy === "plugin_wins") {
          const enabled = batch.toolToggles[tool.name] ?? true;
          toolMap.set(tool.name, {
            tool,
            source: "plugin",
            pluginPackage: batch.id,
            order: pluginOrder,
          });
          state.set(tool.name, {
            name: tool.name,
            source: "plugin",
            pluginPackage: batch.id,
            enabled,
            immutable: false,
            configurable: true,
            available: true,
            reason: enabled ? "enabled" : "disabled_by_user",
          });
          continue;
        }

        const error =
          conflictPolicy === "error"
            ? `${batch.label} tool '${tool.name}' conflicts with built-in tool. Using built-in (conflictPolicy: "error").`
            : undefined;

        state.set(`conflict:${batch.id}:${tool.name}`, {
          name: tool.name,
          source: "plugin",
          pluginPackage: batch.id,
          enabled: false,
          immutable: false,
          configurable: true,
          available: false,
          reason: "conflict_dropped",
          error,
        });
        if (error) {
          pluginErrors.push({ package: batch.id, enabled: true, error });
        }
        state.set(tool.name, existingState);
        continue;
      }

      if (existing && existing.source === "plugin") {
        state.set(`conflict:${batch.id}:${tool.name}`, {
          name: tool.name,
          source: "plugin",
          pluginPackage: batch.id,
          enabled: false,
          immutable: false,
          configurable: true,
          available: false,
          reason: "conflict_dropped",
          error: `${batch.label} tool '${tool.name}' conflicts with tool from '${existing.pluginPackage}'. Using '${existing.pluginPackage}'.`,
        });
        continue;
      }

      const enabled = batch.toolToggles[tool.name] ?? true;
      toolMap.set(tool.name, {
        tool,
        source: "plugin",
        pluginPackage: batch.id,
        order: pluginOrder,
      });
      state.set(tool.name, {
        name: tool.name,
        source: "plugin",
        pluginPackage: batch.id,
        enabled,
        immutable: false,
        configurable: true,
        available: true,
        reason: enabled ? "enabled" : "disabled_by_user",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 5: freeze
// ---------------------------------------------------------------------------

/**
 * Build the final ToolCatalogResult from the resolved tool map and state.
 * Applies image downscaling to all enabled tools.
 */
export function freeze(
  toolMap: Map<string, ToolMapEntry>,
  state: Map<string, ToolStateEntry>,
  plugins: PluginStateEntry[],
  pluginErrors: PluginLoadError[],
): ToolCatalogResult {
  const finalEntries = [...toolMap.values()].sort(compareEntries);
  const tools: Tool[] = [];

  for (const entry of finalEntries) {
    const toolState = state.get(entry.tool.name);
    if (toolState?.enabled) {
      tools.push(withImageDownscaling(entry.tool));
    }
  }

  const orderedState = [...state.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => {
      const aCurrent = toolMap.get(a.value.name);
      const bCurrent = toolMap.get(b.value.name);
      const aOrder = aCurrent?.order ?? Number.MAX_SAFE_INTEGER;
      const bOrder = bCurrent?.order ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder || a.value.name.localeCompare(b.value.name) || a.key.localeCompare(b.key);
    })
    .map((entry) => entry.value);

  return { tools, state: orderedState, plugins, pluginErrors };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Build a resolved tool catalog from built-in tools, plugin tools, and config.
 *
 * Runs the five-phase pipeline:
 *   loadBuiltins → loadBundledBatches → loadPluginBatches → resolveConflicts → freeze
 */
export async function buildToolCatalog(
  builtinTools: Tool[],
  toolsConfig: DiligentConfig["tools"],
  cwd: string,
  host?: RuntimeToolHost,
  options: BuildToolCatalogOptions = {},
): Promise<ToolCatalogResult> {
  const config = toolsConfig ?? {};
  const conflictPolicy: ConflictPolicy = config.conflictPolicy ?? "error";
  const builtinToggles = config.builtin ?? {};
  const explicitPlugins = config.plugins ?? [];
  const bundledProviders = options.bundledProviders ?? [];
  const supersededPluginPackages = new Set(
    bundledProviders.flatMap((provider) => provider.supersedesPluginPackages ?? []),
  );

  // Auto-discover plugins from ~/.diligent/plugins/ and merge with explicit config.
  // Explicit config entries always take precedence (for enable/disable, per-tool toggles, etc.).
  const discoveredNames = await discoverGlobalPlugins();
  const explicitPackageNames = new Set(explicitPlugins.map((p) => p.package));
  const autoPlugins = discoveredNames
    .filter((name) => !explicitPackageNames.has(name))
    .filter((name) => !supersededPluginPackages.has(name))
    .map((name) => ({
      package: name,
      enabled: true as const,
      tools: undefined as Record<string, boolean> | undefined,
    }));
  const pluginConfigs = [...explicitPlugins, ...autoPlugins];

  // Phase 1: builtins
  const { toolMap, state } = loadBuiltins(builtinTools, builtinToggles);

  // Phase 2: bundled providers
  const bundledOrderStart = toolMap.size;
  const { batches: bundledBatches, errors: bundledErrors } = await loadBundledBatches(
    bundledProviders,
    cwd,
    host,
    bundledOrderStart,
  );

  // Phase 3: plugins
  const pluginOrderStart = bundledOrderStart + bundledProviders.length * 1000;
  const {
    batches: pluginBatches,
    plugins,
    errors: pluginLoadErrors,
    deferredStateEntries,
  } = await loadPluginBatches(pluginConfigs, supersededPluginPackages, cwd, host, pluginOrderStart);

  // Apply deferred state entries from disabled/superseded/invalid tools.
  for (const [key, entry] of deferredStateEntries) {
    state.set(key, entry);
  }

  // Phase 4: resolve conflicts across all batches
  const pluginErrors: PluginLoadError[] = [...bundledErrors, ...pluginLoadErrors];
  resolveConflicts([...bundledBatches, ...pluginBatches], toolMap, state, pluginErrors, conflictPolicy);

  // Phase 5: freeze into final result
  return freeze(toolMap, state, plugins, pluginErrors);
}
