// @summary Loads and merges DiligentConfig from global (~/.diligent/config.jsonc), project (.diligent/config.jsonc), and environment layers
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@diligent/logging";
import { parse as parseJsonc } from "jsonc-parser";
import { resolveProjectDirName } from "../infrastructure/diligent-dir";
import { normalizeLegacyModelRef } from "../model/legacy-model-ref";
import { DEFAULT_CONFIG, type DiligentConfig, DiligentConfigSchema } from "./schema";

const logger = createLogger({ scope: "runtime.config" });

/** Load and merge config from all sources (D033: global < project < env) */
export interface DiligentConfigLayers {
  global?: DiligentConfig;
  project?: DiligentConfig;
}

export async function loadDiligentConfig(
  cwd: string,
): Promise<{ config: DiligentConfig; sources: string[]; layers: DiligentConfigLayers }> {
  const sources: string[] = [];
  const projectDirName = resolveProjectDirName();

  // Layer 1: Global config
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const globalPath = join(home, projectDirName, "config.jsonc");
  const globalConfig = await loadConfigFile(globalPath);
  if (globalConfig) sources.push(globalPath);

  // Layer 2: Project config (inside .diligent/ alongside sessions, knowledge, skills)
  const projectPath = join(cwd, projectDirName, "config.jsonc");
  const projectConfig = await loadConfigFile(projectPath);
  if (projectConfig) sources.push(projectPath);

  // Merge: global < project < env
  let merged: DiligentConfig = { ...DEFAULT_CONFIG };
  if (globalConfig) merged = mergeConfig(merged, globalConfig);
  if (projectConfig) merged = mergeConfig(merged, projectConfig);

  // Tool settings are global-only: ignore project-level tools overrides.
  if (globalConfig?.tools) {
    merged.tools = globalConfig.tools;
  } else {
    delete merged.tools;
  }

  return {
    config: merged,
    sources,
    layers: {
      ...(globalConfig ? { global: globalConfig } : {}),
      ...(projectConfig ? { project: projectConfig } : {}),
    },
  };
}

/** Parse JSONC file, validate with Zod */
async function loadConfigFile(path: string): Promise<DiligentConfig | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const text = await file.text();
    const parsed = parseJsonc(text);
    const substituted = substituteTemplates(parsed);
    if (typeof substituted === "object" && substituted !== null && "model" in substituted) {
      const record = substituted as Record<string, unknown>;
      if (record.model !== undefined) record.model = normalizeLegacyModelRef(record.model);
    }
    const result = DiligentConfigSchema.safeParse(substituted);
    if (!result.success) {
      logger.warn("invalid_config", {
        message: `Config warning: ${path}\n${result.error.message}`,
        error: result.error,
        fields: { path },
      });
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

/** Deep merge with array concatenation for 'instructions' (D034) */
export function mergeConfig(base: DiligentConfig, override: DiligentConfig): DiligentConfig {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (key === "instructions" && Array.isArray(value)) {
      const baseInstructions = (base as Record<string, unknown>).instructions as string[] | undefined;
      (merged as Record<string, unknown>).instructions = [...new Set([...(baseInstructions ?? []), ...value])];
    } else if (key === "model") {
      (merged as Record<string, unknown>)[key] = value;
    } else if (isPlainObject(value)) {
      const baseValue = (base as Record<string, unknown>)[key];
      (merged as Record<string, unknown>)[key] = isPlainObject(baseValue)
        ? mergePlainObjects(baseValue, value)
        : mergePlainObjects({}, value);
    } else {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

function mergePlainObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const baseValue = merged[key];

    if (isPlainObject(value) && isPlainObject(baseValue)) {
      merged[key] = mergePlainObjects(baseValue, value);
      continue;
    }

    if (Array.isArray(value)) {
      merged[key] = [...value];
      continue;
    }

    if (isPlainObject(value)) {
      merged[key] = mergePlainObjects({}, value);
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Template substitution: {env:VAR_NAME} → process.env[VAR_NAME] */
function substituteTemplates(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\{env:([^}]+)\}/g, (_, varName) => process.env[varName] ?? "");
  }
  if (Array.isArray(obj)) return obj.map((item) => substituteTemplates(item));
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = substituteTemplates(v);
    }
    return result;
  }
  return obj;
}
