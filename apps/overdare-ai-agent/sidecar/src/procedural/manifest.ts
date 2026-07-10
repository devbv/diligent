// @summary Persistence for saved procedural models (scripts + generation manifests).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProceduralParameters } from "./types";

/**
 * Links a persisted model's identity to its last-applied generation so re-runs
 * can idempotently delete the prior generation before re-applying. Scene
 * `properties` are strict and cannot hold this link, so it lives on disk.
 */
export interface ProceduralModelManifest {
  version: 1;
  generationId: string;
  scriptName?: string;
  /** Project-relative path to the persisted `.lua` script. */
  scriptPath: string;
  parameters: ProceduralParameters;
  /** Parent the last generation was applied under (for drift-tolerant re-runs). */
  parentGuid?: string;
  /** Top-level GUIDs created by the last apply; deleted first on the next run. */
  rootGuids: string[];
  updatedAt: string;
}

const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Rejects ids that could escape the models/scripts directories. */
export function assertSafeGenerationId(generationId: string): void {
  if (!GENERATION_ID_PATTERN.test(generationId)) {
    throw new Error(
      `Invalid generationId "${generationId}": use only letters, digits, '.', '_', '-' (must start alphanumeric).`,
    );
  }
}

export function proceduralDir(cwd: string): string {
  return join(cwd, ".overdare", "procedural");
}

export function modelsDir(cwd: string): string {
  return join(proceduralDir(cwd), "models");
}

export function scriptsDir(cwd: string): string {
  return join(proceduralDir(cwd), "scripts");
}

export function manifestPath(cwd: string, generationId: string): string {
  assertSafeGenerationId(generationId);
  return join(modelsDir(cwd), `${generationId}.json`);
}

/** Project-relative script path stored in the manifest. */
export function scriptRelativePath(generationId: string): string {
  assertSafeGenerationId(generationId);
  return join(".overdare", "procedural", "scripts", `${generationId}.lua`);
}

export function scriptAbsolutePath(cwd: string, generationId: string): string {
  assertSafeGenerationId(generationId);
  return join(scriptsDir(cwd), `${generationId}.lua`);
}

/** Writes the persisted script to its canonical location and returns its relative path. */
export function writeModelScript(cwd: string, generationId: string, source: string): string {
  assertSafeGenerationId(generationId);
  mkdirSync(scriptsDir(cwd), { recursive: true });
  writeFileSync(scriptAbsolutePath(cwd, generationId), source, "utf8");
  return scriptRelativePath(generationId);
}

export function readModelScript(cwd: string, manifest: ProceduralModelManifest): string {
  return readFileSync(join(cwd, manifest.scriptPath), "utf8");
}

export function readManifest(cwd: string, generationId: string): ProceduralModelManifest | undefined {
  const path = manifestPath(cwd, generationId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as ProceduralModelManifest;
}

export function writeManifest(cwd: string, manifest: ProceduralModelManifest): void {
  assertSafeGenerationId(manifest.generationId);
  mkdirSync(modelsDir(cwd), { recursive: true });
  writeFileSync(manifestPath(cwd, manifest.generationId), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function listManifests(cwd: string): ProceduralModelManifest[] {
  const dir = modelsDir(cwd);
  if (!existsSync(dir)) return [];
  const manifests: ProceduralModelManifest[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      manifests.push(JSON.parse(readFileSync(join(dir, entry.name), "utf8")) as ProceduralModelManifest);
    } catch {
      // ignore malformed manifests
    }
  }
  return manifests.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
