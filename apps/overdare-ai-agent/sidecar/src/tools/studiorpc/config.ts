import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_STORAGE_NAMESPACE = "diligent";
const PACKAGED_STORAGE_NAMESPACE = "overdare";

const DEFAULT_STUDIO_HOST = "localhost";
const DEFAULT_STUDIO_PORT = 13377;

export interface OverdareConfig {
  host?: string;
  port?: number;
  apiVersion?: string;
}

export type StudioApiVersion = "v1" | "v2";

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

/**
 * Resolve the Studio RPC host.
 * Priority: STUDIO_HOST env var > config file > DEFAULT_STUDIO_HOST.
 */
export function resolveStudioHost(): string {
  if (process.env.STUDIO_HOST) return process.env.STUDIO_HOST;
  return loadOverdareConfig().host ?? DEFAULT_STUDIO_HOST;
}

/**
 * Resolve the Studio RPC port.
 * Priority: STUDIO_PORT env var > config file > DEFAULT_STUDIO_PORT.
 */
export function resolveStudioPort(): number {
  const envPort = process.env.STUDIO_PORT;
  if (envPort) {
    const parsed = Number(envPort);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return loadOverdareConfig().port ?? DEFAULT_STUDIO_PORT;
}

/**
 * Resolve the Studio RPC API version.
 * Priority: STUDIO_API_VERSION env var > config file `apiVersion` > "v2".
 *
 * v2 is the default: the RPC path is what the agent uses unless something asks
 * for the old file backend. Only the exact string "v1" selects v1 — anything
 * else, including "V1", a missing key, and a config file that cannot be read,
 * is v2. A config that names no `apiVersion` therefore keeps the default, so
 * setting host/port does not silently opt out.
 *
 * The config file is re-read on every call rather than going through
 * `loadOverdareConfig`, whose process-lifetime cache would otherwise make a
 * version change require a restart.
 */
export function resolveApiVersion(): StudioApiVersion {
  const envVersion = process.env.STUDIO_API_VERSION;
  if (envVersion) return envVersion === "v1" ? "v1" : "v2";

  for (const configPath of configCandidates()) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsonComments(raw)) as OverdareConfig;
      if (config.apiVersion !== undefined) return config.apiVersion === "v1" ? "v1" : "v2";
    } catch {
      // A config that cannot be read states nothing — it is not a request for v1.
      return "v2";
    }
    // The first config that exists decides; a later candidate must not override it.
    break;
  }
  return "v2";
}
