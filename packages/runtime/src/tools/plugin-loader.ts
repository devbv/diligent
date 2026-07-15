// @summary Dynamic plugin package loader — imports npm packages and validates tool exports

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Tool as HostTool, ToolResult as HostToolResult } from "@diligent/core/tool/types";
import { createLogger } from "@diligent/logging";
import type {
  Tool as PluginTool,
  ToolContext as PluginToolContext,
  ToolResult as PluginToolResult,
} from "@diligent/plugin-sdk";
import { ToolRenderPayloadSchema } from "@diligent/protocol";
import type { ApprovalRequest } from "../approval/types";
import type { DiligentConfig } from "../config/schema";
import type { PluginHookFn } from "../hooks/runner";
import { resolveProjectDirName } from "../infrastructure/diligent-dir";
import type { RuntimeToolHost } from "./capabilities";
import type { UserInputRequest } from "./user-input-types";

const logger = createLogger({ scope: "runtime.tools.plugin-loader" });

export interface PluginManifest {
  name: string;
  apiVersion: string;
  version: string;
}

export interface InvalidPluginTool {
  name: string;
  error: string;
}

export interface PluginLoadResult {
  package: string;
  manifest?: PluginManifest;
  tools: HostTool[];
  error?: string;
  warnings?: string[];
  invalidTools?: InvalidPluginTool[];
}

export interface CollectedPluginHooks {
  onUserPromptSubmit: PluginHookFn[];
  onStop: PluginHookFn[];
}

const pluginHooksCache = new Map<string, CollectedPluginHooks>();

/**
 * Collect lifecycle hook handlers exported by enabled plugins.
 *
 * Plugins may optionally export:
 *   export async function onUserPromptSubmit(input: PluginHookInput): Promise<PluginHookResult>
 *   export async function onStop(input: PluginHookInput): Promise<PluginHookResult>
 *
 * Results are cached per (toolsConfig, cwd) tuple. The cache is invalidated when
 * the serialized config key changes, which happens when plugin list or enabled state changes.
 *
 * Plugins that fail to load are skipped silently (non-blocking).
 */
export async function collectPluginHooks(
  toolsConfig: DiligentConfig["tools"],
  cwd: string,
): Promise<CollectedPluginHooks> {
  const cacheKey = JSON.stringify({ toolsConfig: toolsConfig ?? null, cwd });
  const cached = pluginHooksCache.get(cacheKey);
  if (cached) return cached;

  const config = toolsConfig ?? {};
  const explicitPlugins = config.plugins ?? [];

  const discoveredNames = await discoverGlobalPlugins();
  const explicitPackageNames = new Set(explicitPlugins.map((p) => p.package));
  const autoPlugins = discoveredNames
    .filter((name) => !explicitPackageNames.has(name))
    .map((name) => ({ package: name, enabled: true as const }));

  const pluginConfigs = [...explicitPlugins, ...autoPlugins];
  const result: CollectedPluginHooks = { onUserPromptSubmit: [], onStop: [] };

  for (const pluginConfig of pluginConfigs) {
    if (!(pluginConfig.enabled ?? true)) continue;

    let mod: Record<string, unknown>;
    try {
      mod = await importPluginModule(pluginConfig.package, cwd);
    } catch {
      continue;
    }

    if (typeof mod.onUserPromptSubmit === "function") {
      result.onUserPromptSubmit.push(mod.onUserPromptSubmit as PluginHookFn);
    }
    if (typeof mod.onStop === "function") {
      result.onStop.push(mod.onStop as PluginHookFn);
    }
  }

  pluginHooksCache.set(cacheKey, result);
  return result;
}

type PluginToolHostContext = PluginToolContext;

/**
 * Resolve the home-level global plugin directory.
 *
 * Example:
 *   ~/.diligent/plugins
 */
export function getGlobalPluginRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return join(home, resolveProjectDirName(), "plugins");
}

/** Resolve a plugin package directory inside the global plugin root. */
export function getGlobalPluginPath(packageName: string): string {
  return join(getGlobalPluginRoot(), packageName);
}

/**
 * Scan the global plugin directory and return the names of all plugin folders found.
 *
 * Only immediate subdirectories are returned (non-recursive).
 * Returns an empty array if the directory does not exist or cannot be read.
 */
export async function discoverGlobalPlugins(): Promise<string[]> {
  const root = getGlobalPluginRoot();
  try {
    const entries: Dirent[] = await readdir(root, { withFileTypes: true });
    const plugins: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        // Scoped package: scan one level deeper → "@scope/package"
        const scopeDir = join(root, entry.name);
        try {
          const scopedEntries: Dirent[] = await readdir(scopeDir, { withFileTypes: true });
          for (const sub of scopedEntries) {
            if (sub.isDirectory()) plugins.push(`${entry.name}/${sub.name}`);
          }
        } catch {
          // ignore unreadable scope dirs
        }
      } else {
        plugins.push(entry.name);
      }
    }
    return plugins;
  } catch {
    // Directory doesn't exist or can't be read — no auto-discovered plugins
    return [];
  }
}

/**
 * Load a plugin package by name and extract its tools.
 *
 * Resolution order:
 *   1. Regular package import (installed in the running project/environment)
 *   2. Home-level global plugin directory (~/.diligent/plugins/<packageName>)
 *
 * Expected plugin module shape:
 *   export const manifest: PluginManifest;
 *   export async function createTools(ctx: { cwd: string }): PluginTool[];
 *
 * Never throws — returns error string on fatal failure and warnings for partial validation issues.
 */
export async function loadPlugin(packageName: string, cwd: string, host?: RuntimeToolHost): Promise<PluginLoadResult> {
  const fail = (error: string): PluginLoadResult => ({
    package: packageName,
    tools: [],
    error,
    warnings: [],
    invalidTools: [],
  });

  let mod: Record<string, unknown>;
  try {
    mod = await importPluginModule(packageName, cwd);
  } catch (err) {
    return fail(String(err));
  }

  // Validate manifest
  const manifest = mod.manifest as PluginManifest | undefined;
  if (!manifest || typeof manifest !== "object") {
    return fail(`Plugin '${packageName}' does not export a 'manifest' object.`);
  }
  if (
    typeof manifest.name !== "string" ||
    typeof manifest.apiVersion !== "string" ||
    typeof manifest.version !== "string"
  ) {
    return fail(`Plugin '${packageName}' manifest is missing required fields (name, apiVersion, version).`);
  }
  if (manifest.name !== packageName) {
    return fail(`Plugin '${packageName}' manifest.name '${manifest.name}' does not match the configured package name.`);
  }

  // Check API version compatibility (major must be 1)
  const majorVersion = parseInt(manifest.apiVersion.split(".")[0], 10);
  if (Number.isNaN(majorVersion) || majorVersion !== 1) {
    return fail(
      `Plugin '${packageName}' requires API version '${manifest.apiVersion}' but only version 1.x is supported.`,
    );
  }

  // Call createTools
  if (typeof mod.createTools !== "function") {
    return fail(`Plugin '${packageName}' does not export a 'createTools' function.`);
  }

  let rawTools: unknown[];
  try {
    const result = await Promise.resolve(mod.createTools({ cwd }));
    if (!Array.isArray(result)) {
      return fail(`Plugin '${packageName}' createTools() must return an array of tools.`);
    }
    rawTools = result;
  } catch (err) {
    return fail(`Plugin '${packageName}' createTools() threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Validate each tool shape (duck-typing) and reject duplicates.
  const validTools: HostTool[] = [];
  const invalidTools: InvalidPluginTool[] = [];
  const warnings: string[] = [];
  const seenNames = new Set<string>();

  for (const tool of rawTools) {
    if (!isValidToolShape(tool)) {
      const name = (tool as { name?: string })?.name ?? "unknown";
      const error = `Tool '${name}' from '${packageName}' has invalid shape.`;
      invalidTools.push({ name, error });
      warnings.push(error);
      continue;
    }

    const typedTool = wrapPluginTool(tool as PluginTool, packageName, host);
    if (seenNames.has(typedTool.name)) {
      const error = `Plugin '${packageName}' exports duplicate tool name '${typedTool.name}'. Later duplicates are ignored.`;
      invalidTools.push({ name: typedTool.name, error });
      warnings.push(error);
      continue;
    }

    seenNames.add(typedTool.name);
    validTools.push(typedTool);
  }

  return {
    package: packageName,
    manifest,
    tools: validTools,
    warnings,
    invalidTools,
  };
}

function wrapPluginTool(tool: PluginTool, packageName: string, host?: RuntimeToolHost): HostTool {
  return {
    ...tool,
    execute: async (args, ctx) => {
      const pluginContext: PluginToolHostContext = Object.assign({}, ctx, {
        approve: async (request: ApprovalRequest) => {
          if (!host?.approve) return "once";
          return host.approve(request);
        },
        ask: async (request: UserInputRequest) => {
          if (!host?.ask) return null;
          return host.ask(request);
        },
      });
      const result = await tool.execute(args, pluginContext);
      return {
        ...(result as PluginToolResult & HostToolResult),
        render: normalizePluginToolRenderPayload({
          toolName: tool.name,
          packageName,
          render: result.render,
        }),
      };
    },
  };
}

function normalizePluginToolRenderPayload(args: {
  toolName: string;
  packageName: string;
  render: unknown;
}): HostToolResult["render"] | undefined {
  if (args.render == null) return undefined;

  const parsed = ToolRenderPayloadSchema.safeParse(args.render);
  if (parsed.success) return parsed.data;

  logger.warn("invalid_render_payload", {
    message: `[plugin-loader] Invalid tool render payload package=${args.packageName} tool=${args.toolName}: ${parsed.error.message}`,
    error: parsed.error,
    fields: { packageName: args.packageName, toolName: args.toolName },
  });
  return undefined;
}

async function importPluginModule(packageName: string, cwd?: string): Promise<Record<string, unknown>> {
  // Resolution order:
  //   1. Regular package import (installed in the running process's environment)
  //   2. cwd/node_modules/<packageName>  (project-local bun/npm install)
  //   3. ~/.diligent/plugins/<packageName>  (global plugin directory)
  try {
    return (await import(packageName)) as Record<string, unknown>;
  } catch (packageError) {
    // 2. Try project-local node_modules when cwd is provided
    if (cwd) {
      const localPath = join(cwd, "node_modules", packageName);
      try {
        await stat(localPath);
        return (await import(pathToFileURL(localPath).href)) as Record<string, unknown>;
      } catch {
        // not found locally — fall through to global
      }
    }

    // 3. Global plugin directory
    const globalPath = getGlobalPluginPath(packageName);
    const globalImportUrl = pathToFileURL(globalPath).href;

    try {
      await stat(globalPath);
    } catch {
      const triedPaths = [...(cwd ? [`${cwd}/node_modules/${packageName}`] : []), globalPath].join(", ");
      throw new Error(
        `Could not load plugin package '${packageName}'. Tried: ${triedPaths}. ` +
          `Install it in the project ('bun add ${packageName}') or place it under ${getGlobalPluginRoot()}. ` +
          `Package import error: ${packageError instanceof Error ? packageError.message : String(packageError)}`,
      );
    }

    try {
      return (await import(globalImportUrl)) as Record<string, unknown>;
    } catch (globalError) {
      throw new Error(
        `Could not load plugin package '${packageName}'. ` +
          `Package import error: ${packageError instanceof Error ? packageError.message : String(packageError)}. ` +
          `Global import error: ${globalError instanceof Error ? globalError.message : String(globalError)}`,
      );
    }
  }
}

function isValidToolShape(tool: unknown): boolean {
  if (typeof tool !== "object" || tool === null) return false;
  const t = tool as Record<string, unknown>;
  return (
    typeof t.name === "string" &&
    typeof t.description === "string" &&
    t.parameters != null &&
    typeof (t.parameters as Record<string, unknown>).parse === "function" &&
    typeof t.execute === "function"
  );
}
