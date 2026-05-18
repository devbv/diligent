import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_STORAGE_NAMESPACE = "diligent";
const PACKAGED_STORAGE_NAMESPACE = "overdare";

export interface OverdareConfig {
  luauLspPath?: string;
  typesPath?: string;
}

function stripJsonComments(text: string): string {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

let cached: OverdareConfig | undefined;

function storageNamespace(): string {
  const value = process.env.DILIGENT_STORAGE_NAMESPACE?.trim();
  return value || PACKAGED_STORAGE_NAMESPACE;
}

function resolveHomeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? homedir();
}

function configCandidates(): string[] {
  const home = resolveHomeDir();
  const currentPath = join(home, `.${storageNamespace()}`, "overdare.jsonc");
  const legacyPath = join(home, `.${DEFAULT_STORAGE_NAMESPACE}`, "overdare.jsonc");
  return currentPath === legacyPath ? [currentPath] : [currentPath, legacyPath];
}

export function loadOverdareConfig(): OverdareConfig {
  if (cached) return cached;
  for (const configPath of configCandidates()) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = readFileSync(configPath, "utf-8");
      cached = JSON.parse(stripJsonComments(raw)) as OverdareConfig;
      return cached;
    } catch {
      cached = {};
      return cached;
    }
  }
  cached = {};
  return cached;
}
