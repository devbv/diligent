// @summary JSONC-preserving writer helpers for config.jsonc tool settings (global: ~/.diligent/config.jsonc, project: .diligent/config.jsonc)
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, format, modify, parse as parseJsonc } from "jsonc-parser";

import { resolveProjectDirName } from "../infrastructure/diligent-dir";
import type { DiligentConfig } from "./schema";
import { DiligentConfigSchema } from "./schema";

const PROJECT_CONFIG_FILE = "config.jsonc";
const GLOBAL_CONFIG_FILE = "config.jsonc";
const JSONC_FORMAT_OPTIONS = {
  tabSize: 2,
  insertSpaces: true,
  eol: "\n",
} as const;

type ConflictPolicy = NonNullable<NonNullable<DiligentConfig["tools"]>["conflictPolicy"]>;

interface BasePluginConfig {
  package: string;
  enabled?: boolean;
  tools?: Record<string, boolean>;
}

type StoredPluginConfig = BasePluginConfig;

export interface ToolPluginPatch extends BasePluginConfig {
  remove?: boolean;
}

export interface ToolConfigPatch {
  web_action?: boolean;
  builtin?: Record<string, boolean>;
  plugins?: ToolPluginPatch[];
  conflictPolicy?: ConflictPolicy;
}

export interface StoredToolsConfig {
  web_action?: false;
  builtin?: Record<string, false>;
  plugins?: Array<{
    package: string;
    enabled?: false;
    tools?: Record<string, false>;
  }>;
  conflictPolicy?: Exclude<ConflictPolicy, "error">;
}

export interface WriteToolsConfigResult {
  configPath: string;
  config: DiligentConfig;
  tools: StoredToolsConfig | undefined;
}

export function getProjectConfigPath(cwd: string): string {
  return join(cwd, resolveProjectDirName(), PROJECT_CONFIG_FILE);
}

export function getGlobalConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return join(home, resolveProjectDirName(), GLOBAL_CONFIG_FILE);
}

/**
 * Save the selected model to the global config file (~/.diligent/config.jsonc).
 * Preserves existing comments and formatting via jsonc-parser.
 */
export async function saveGlobalModel(modelId: string): Promise<void> {
  const configPath = getGlobalConfigPath();
  await mkdir(dirname(configPath), { recursive: true });

  let content = "{}\n";
  const file = Bun.file(configPath);
  if (await file.exists()) {
    content = await file.text();
  }

  const edits = modify(content, ["model"], modelId, { formattingOptions: JSONC_FORMAT_OPTIONS });
  const updated = applyEdits(content, edits);
  if (content.trim() === "{}" || content.trim() === "") {
    const formatEdits = format(updated, undefined, JSONC_FORMAT_OPTIONS);
    await Bun.write(configPath, applyEdits(updated, formatEdits));
  } else {
    await Bun.write(configPath, updated);
  }
}

/**
 * Persist the auto progress mode toggle to the global config file (~/.diligent/config.jsonc).
 * When a userId is available, the value is account-scoped under accounts.<userId>.
 * Preserves existing comments and formatting via jsonc-parser.
 */
export async function saveGlobalAutoProgressMode(enabled: boolean, userId?: string): Promise<void> {
  const configPath = getGlobalConfigPath();
  await mkdir(dirname(configPath), { recursive: true });

  let content = "{}\n";
  const file = Bun.file(configPath);
  if (await file.exists()) {
    content = await file.text();
  }

  const path = userId?.trim() ? ["accounts", userId.trim(), "autoProgressMode"] : ["autoProgressMode"];
  const edits = modify(content, path, enabled, { formattingOptions: JSONC_FORMAT_OPTIONS });
  const updated = applyEdits(content, edits);
  if (content.trim() === "{}" || content.trim() === "") {
    const formatEdits = format(updated, undefined, JSONC_FORMAT_OPTIONS);
    await Bun.write(configPath, applyEdits(updated, formatEdits));
  } else {
    await Bun.write(configPath, updated);
  }
}

/**
 * Persist the AI-data consent subtree to the global config file (~/.diligent/config.jsonc).
 * Writes the whole resolved `consent` object so toggles/acknowledgement stay in one place.
 * Preserves existing comments and formatting via jsonc-parser.
 */
export async function saveGlobalConsent(consent: NonNullable<DiligentConfig["consent"]>): Promise<void> {
  const configPath = getGlobalConfigPath();
  await mkdir(dirname(configPath), { recursive: true });

  let content = "{}\n";
  const file = Bun.file(configPath);
  if (await file.exists()) {
    content = await file.text();
  }

  const edits = modify(content, ["consent"], consent, { formattingOptions: JSONC_FORMAT_OPTIONS });
  const updated = applyEdits(content, edits);
  if (content.trim() === "{}" || content.trim() === "") {
    const formatEdits = format(updated, undefined, JSONC_FORMAT_OPTIONS);
    await Bun.write(configPath, applyEdits(updated, formatEdits));
  } else {
    await Bun.write(configPath, updated);
  }
}

export function normalizeStoredToolsConfig(
  tools: DiligentConfig["tools"] | ToolConfigPatch | undefined,
): StoredToolsConfig | undefined {
  if (!tools) return undefined;

  const webAction = tools.web_action === false ? false : undefined;
  const normalizedBuiltin = normalizeFalseOnlyMap(tools.builtin);
  const plugins = normalizePluginConfigs(tools.plugins);
  const conflictPolicy = tools.conflictPolicy && tools.conflictPolicy !== "error" ? tools.conflictPolicy : undefined;

  if (webAction === undefined && !normalizedBuiltin && !plugins && !conflictPolicy) {
    return undefined;
  }

  return {
    ...(webAction === false ? { web_action: webAction } : {}),
    ...(normalizedBuiltin ? { builtin: normalizedBuiltin } : {}),
    ...(plugins ? { plugins } : {}),
    ...(conflictPolicy ? { conflictPolicy } : {}),
  };
}

export function applyToolConfigPatch(
  current: DiligentConfig["tools"] | undefined,
  patch: ToolConfigPatch,
): StoredToolsConfig | undefined {
  const nextWebAction = patch.web_action ?? current?.web_action;
  const mergedBuiltin = mergeBooleanMaps(current?.builtin, patch.builtin);
  const mergedPlugins = mergePluginPatches(current?.plugins ?? [], patch.plugins ?? []);
  const nextConflictPolicy = patch.conflictPolicy ?? current?.conflictPolicy;

  return normalizeStoredToolsConfig({
    web_action: nextWebAction,
    builtin: mergedBuiltin,
    plugins: mergedPlugins,
    conflictPolicy: nextConflictPolicy,
  });
}

export async function writeProjectToolsConfig(cwd: string, patch: ToolConfigPatch): Promise<WriteToolsConfigResult> {
  return writeToolsConfigAtPath(getProjectConfigPath(cwd), patch);
}

export async function writeGlobalToolsConfig(patch: ToolConfigPatch): Promise<WriteToolsConfigResult> {
  return writeToolsConfigAtPath(getGlobalConfigPath(), patch);
}

async function writeToolsConfigAtPath(configPath: string, patch: ToolConfigPatch): Promise<WriteToolsConfigResult> {
  await mkdir(dirname(configPath), { recursive: true });

  let content = "{}\n";
  const file = Bun.file(configPath);
  if (await file.exists()) {
    content = await file.text();
  }

  const parsed = parseJsonc(content);
  const validatedCurrent = DiligentConfigSchema.safeParse(parsed);
  const currentConfig = validatedCurrent.success ? validatedCurrent.data : ({} as DiligentConfig);

  const nextTools = applyToolConfigPatch(currentConfig.tools, patch);
  const updatedText = updateToolsSubtree(content, nextTools);
  await Bun.write(configPath, updatedText);

  const reparsed = parseJsonc(updatedText);
  const result = DiligentConfigSchema.safeParse(reparsed);
  if (!result.success) {
    throw new Error(`Failed to validate updated config at ${configPath}: ${result.error.message}`);
  }

  return {
    configPath,
    config: result.data,
    tools: normalizeStoredToolsConfig(result.data.tools),
  };
}

function updateToolsSubtree(content: string, tools: StoredToolsConfig | undefined): string {
  const edits = modify(content, ["tools"], tools, { formattingOptions: JSONC_FORMAT_OPTIONS });
  const updated = applyEdits(content, edits);
  if (content.trim() === "{}" || content.trim() === "") {
    const formatEdits = format(updated, undefined, JSONC_FORMAT_OPTIONS);
    return applyEdits(updated, formatEdits);
  }
  return updated;
}

function normalizeFalseOnlyMap(input: Record<string, boolean> | undefined): Record<string, false> | undefined {
  if (!input) return undefined;

  const entries = Object.entries(input)
    .filter(([, enabled]) => enabled === false)
    .sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([name]) => [name, false])) as Record<string, false>;
}

function normalizePluginConfigs(
  plugins: BasePluginConfig[] | ToolPluginPatch[] | undefined,
): StoredToolsConfig["plugins"] {
  if (!plugins || plugins.length === 0) return undefined;

  const normalized = plugins.map((plugin) => {
    const tools = normalizeFalseOnlyMap(plugin.tools);
    return {
      package: plugin.package,
      ...(plugin.enabled === false ? { enabled: false as const } : {}),
      ...(tools ? { tools } : {}),
    };
  });

  return normalized.length > 0 ? normalized : undefined;
}

function mergeBooleanMaps(
  base: Record<string, boolean> | undefined,
  patch: Record<string, boolean> | undefined,
): Record<string, boolean> | undefined {
  if (!base && !patch) return undefined;
  const merged = new Map<string, boolean>();
  for (const [name, enabled] of Object.entries(base ?? {})) {
    merged.set(name, enabled);
  }
  for (const [name, enabled] of Object.entries(patch ?? {})) {
    merged.set(name, enabled);
  }
  return merged.size > 0 ? Object.fromEntries(merged) : undefined;
}

function mergePluginPatches(
  existing: StoredPluginConfig[],
  patches: ToolPluginPatch[],
): StoredPluginConfig[] | undefined {
  const merged = new Map<string, StoredPluginConfig>();
  const orderedPackages: string[] = [];

  for (const plugin of existing) {
    merged.set(plugin.package, {
      package: plugin.package,
      enabled: plugin.enabled,
      tools: plugin.tools ? { ...plugin.tools } : undefined,
    });
    orderedPackages.push(plugin.package);
  }

  for (const patch of patches) {
    if (patch.remove) {
      merged.delete(patch.package);
      continue;
    }

    if (!merged.has(patch.package)) {
      orderedPackages.push(patch.package);
    }

    const current = merged.get(patch.package) ?? { package: patch.package };
    merged.set(patch.package, {
      package: patch.package,
      enabled: patch.enabled ?? current.enabled,
      tools: mergeBooleanMaps(current.tools, patch.tools),
    });
  }

  const result = orderedPackages
    .filter((packageName) => merged.has(packageName))
    .map((packageName) => merged.get(packageName)!);
  return result.length > 0 ? result : undefined;
}
