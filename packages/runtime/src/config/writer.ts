// @summary JSONC-preserving writer helpers for config.jsonc tool settings (global: ~/.diligent/config.jsonc, project: .diligent/config.jsonc)
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, format, modify, type ParseError, parse as parseJsonc } from "jsonc-parser";

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

export interface SkillConfigPatch {
  overrides?: Record<string, boolean>;
}

export interface StoredSkillsConfig {
  enabled?: boolean;
  paths?: string[];
  overrides?: Record<string, false>;
}

export interface WriteSkillsConfigResult {
  configPath: string;
  config: DiligentConfig;
  skills: StoredSkillsConfig | undefined;
}

export interface AgentConfigPatch {
  overrides?: Record<string, boolean>;
}

export interface StoredAgentsConfig {
  enabled?: boolean;
  paths?: string[];
  overrides?: Record<string, false>;
}

export interface WriteAgentsConfigResult {
  configPath: string;
  config: DiligentConfig;
  agents: StoredAgentsConfig | undefined;
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

/** Persist product experiment overrides while preserving unrelated JSONC content. */
export async function saveGlobalExperimentOverrides(overrides: Record<string, boolean>): Promise<void> {
  const configPath = getGlobalConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  let content = "{}\n";
  const file = Bun.file(configPath);
  if (await file.exists()) content = await file.text();
  const value = Object.keys(overrides).length > 0 ? overrides : undefined;
  const edits = modify(content, ["experiments", "overrides"], value, { formattingOptions: JSONC_FORMAT_OPTIONS });
  await Bun.write(configPath, applyEdits(content, edits));
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

export function normalizeStoredSkillsConfig(
  skills: DiligentConfig["skills"] | undefined,
): StoredSkillsConfig | undefined {
  if (!skills) return undefined;

  const overrides = normalizeFalseOnlyMap(skills.overrides);
  if (skills.enabled === undefined && skills.paths === undefined && !overrides) {
    return undefined;
  }

  return {
    ...(skills.enabled !== undefined ? { enabled: skills.enabled } : {}),
    ...(skills.paths !== undefined ? { paths: [...skills.paths] } : {}),
    ...(overrides ? { overrides } : {}),
  };
}

export function applySkillConfigPatch(
  current: DiligentConfig["skills"] | undefined,
  patch: SkillConfigPatch,
): StoredSkillsConfig | undefined {
  const mergedOverrides = mergeBooleanMaps(current?.overrides, patch.overrides);
  return normalizeStoredSkillsConfig({
    ...(current?.enabled !== undefined ? { enabled: current.enabled } : {}),
    ...(current?.paths !== undefined ? { paths: current.paths } : {}),
    ...(mergedOverrides ? { overrides: mergedOverrides } : {}),
  });
}

export async function writeGlobalSkillsConfig(patch: SkillConfigPatch): Promise<WriteSkillsConfigResult> {
  return writeSkillsConfigAtPath(getGlobalConfigPath(), patch);
}

export function normalizeStoredAgentsConfig(
  agents: DiligentConfig["agents"] | undefined,
): StoredAgentsConfig | undefined {
  if (!agents) return undefined;

  const overrides = normalizeFalseOnlyMap(agents.overrides);
  if (agents.enabled === undefined && agents.paths === undefined && !overrides) {
    return undefined;
  }

  return {
    ...(agents.enabled !== undefined ? { enabled: agents.enabled } : {}),
    ...(agents.paths !== undefined ? { paths: [...agents.paths] } : {}),
    ...(overrides ? { overrides } : {}),
  };
}

export function applyAgentConfigPatch(
  current: DiligentConfig["agents"] | undefined,
  patch: AgentConfigPatch,
): StoredAgentsConfig | undefined {
  const mergedOverrides = mergeBooleanMaps(current?.overrides, patch.overrides);
  return normalizeStoredAgentsConfig({
    ...(current?.enabled !== undefined ? { enabled: current.enabled } : {}),
    ...(current?.paths !== undefined ? { paths: current.paths } : {}),
    ...(mergedOverrides ? { overrides: mergedOverrides } : {}),
  });
}

export async function writeGlobalAgentsConfig(patch: AgentConfigPatch): Promise<WriteAgentsConfigResult> {
  return writeAgentsConfigAtPath(getGlobalConfigPath(), patch);
}

async function writeSkillsConfigAtPath(configPath: string, patch: SkillConfigPatch): Promise<WriteSkillsConfigResult> {
  await mkdir(dirname(configPath), { recursive: true });

  let content = "{}\n";
  const file = Bun.file(configPath);
  if (await file.exists()) {
    content = await file.text();
  }

  const parseErrors: ParseError[] = [];
  const parsed = parseJsonc(content, parseErrors);
  if (parseErrors.length > 0) {
    throw new Error(`Failed to parse existing config at ${configPath}`);
  }
  const validatedCurrent = DiligentConfigSchema.safeParse(parsed);
  if (!validatedCurrent.success) {
    throw new Error(`Failed to validate existing config at ${configPath}: ${validatedCurrent.error.message}`);
  }
  const currentConfig = validatedCurrent.data;

  const nextSkills = applySkillConfigPatch(currentConfig.skills, patch);
  const updatedText = updateSkillsSubtree(content, currentConfig.skills, nextSkills);
  await Bun.write(configPath, updatedText);

  const reparsed = parseJsonc(updatedText);
  const result = DiligentConfigSchema.safeParse(reparsed);
  if (!result.success) {
    throw new Error(`Failed to validate updated config at ${configPath}: ${result.error.message}`);
  }

  return {
    configPath,
    config: result.data,
    skills: normalizeStoredSkillsConfig(result.data.skills),
  };
}

async function writeAgentsConfigAtPath(configPath: string, patch: AgentConfigPatch): Promise<WriteAgentsConfigResult> {
  await mkdir(dirname(configPath), { recursive: true });

  let content = "{}\n";
  const file = Bun.file(configPath);
  if (await file.exists()) content = await file.text();

  const parseErrors: ParseError[] = [];
  const parsed = parseJsonc(content, parseErrors);
  if (parseErrors.length > 0) {
    throw new Error(`Failed to parse existing config at ${configPath}`);
  }
  const validatedCurrent = DiligentConfigSchema.safeParse(parsed);
  if (!validatedCurrent.success) {
    throw new Error(`Failed to validate existing config at ${configPath}: ${validatedCurrent.error.message}`);
  }
  const currentConfig = validatedCurrent.data;
  const nextAgents = applyAgentConfigPatch(currentConfig.agents, patch);
  const updatedText = updateAgentsSubtree(content, currentConfig.agents, nextAgents);
  await Bun.write(configPath, updatedText);

  const result = DiligentConfigSchema.safeParse(parseJsonc(updatedText));
  if (!result.success) {
    throw new Error(`Failed to validate updated config at ${configPath}: ${result.error.message}`);
  }
  return {
    configPath,
    config: result.data,
    agents: normalizeStoredAgentsConfig(result.data.agents),
  };
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

function updateSkillsSubtree(
  content: string,
  currentSkills: DiligentConfig["skills"] | undefined,
  nextSkills: StoredSkillsConfig | undefined,
): string {
  if (!nextSkills) {
    return applyConfigEdit(content, ["skills"], undefined);
  }

  let updated = content;
  const currentOverrides = currentSkills?.overrides ?? {};
  const nextOverrides = nextSkills.overrides ?? {};

  for (const [name, enabled] of Object.entries(currentOverrides)) {
    if (nextOverrides[name] === false) {
      if (enabled !== false) {
        updated = applyConfigEdit(updated, ["skills", "overrides", name], false);
      }
      continue;
    }
    updated = applyConfigEdit(updated, ["skills", "overrides", name], undefined);
  }

  for (const name of Object.keys(nextOverrides)) {
    if (!Object.hasOwn(currentOverrides, name)) {
      updated = applyConfigEdit(updated, ["skills", "overrides", name], false);
    }
  }

  if (Object.keys(nextOverrides).length === 0 && Object.keys(currentOverrides).length > 0) {
    updated = applyConfigEdit(updated, ["skills", "overrides"], undefined);
  }

  if (!currentSkills && Object.keys(nextOverrides).length === 0) {
    updated = applyConfigEdit(updated, ["skills"], nextSkills);
  }

  if (content.trim() === "{}" || content.trim() === "") {
    const formatEdits = format(updated, undefined, JSONC_FORMAT_OPTIONS);
    return applyEdits(updated, formatEdits);
  }
  return updated;
}

function updateAgentsSubtree(
  content: string,
  currentAgents: DiligentConfig["agents"] | undefined,
  nextAgents: StoredAgentsConfig | undefined,
): string {
  if (!nextAgents) return applyConfigEdit(content, ["agents"], undefined);

  let updated = content;
  const currentOverrides = currentAgents?.overrides ?? {};
  const nextOverrides = nextAgents.overrides ?? {};
  for (const [name, enabled] of Object.entries(currentOverrides)) {
    if (nextOverrides[name] === false) {
      if (enabled !== false) updated = applyConfigEdit(updated, ["agents", "overrides", name], false);
      continue;
    }
    updated = applyConfigEdit(updated, ["agents", "overrides", name], undefined);
  }
  for (const name of Object.keys(nextOverrides)) {
    if (!Object.hasOwn(currentOverrides, name))
      updated = applyConfigEdit(updated, ["agents", "overrides", name], false);
  }
  if (Object.keys(nextOverrides).length === 0 && Object.keys(currentOverrides).length > 0) {
    updated = applyConfigEdit(updated, ["agents", "overrides"], undefined);
  }
  if (!currentAgents && Object.keys(nextOverrides).length === 0) {
    updated = applyConfigEdit(updated, ["agents"], nextAgents);
  }
  if (content.trim() === "{}" || content.trim() === "") {
    return applyEdits(updated, format(updated, undefined, JSONC_FORMAT_OPTIONS));
  }
  return updated;
}

function applyConfigEdit(content: string, path: (string | number)[], value: unknown): string {
  const edits = modify(content, path, value, { formattingOptions: JSONC_FORMAT_OPTIONS });
  return applyEdits(content, edits);
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
