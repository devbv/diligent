// @summary Rollback snapshot helpers: capture/restore .ovdrjm level snapshots.

import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "@diligent/runtime";
import { resolveOvdrjmPathFromUmap } from "./ovdrjm-utils";

/**
 * Directory holding rollback snapshots, under the project's storage-namespace
 * dir (`.overdare/snapshots` in prod, `.diligent/snapshots` in dev). Uses
 * resolvePaths so the namespace and dot-prefix follow the project convention.
 */
export function snapshotsDir(cwd: string): string {
  return join(resolvePaths(cwd).root, "snapshots");
}

/**
 * Next request index for a session, derived by scanning the snapshots dir.
 * Filesystem is the source of truth so the counter survives agent restarts.
 * Snapshots are named `{sessionId}_{index}.ovdrjm`.
 */
export function nextRequestIndex(snapshotsDir: string, sessionId: string): number {
  let entries: string[];
  try {
    entries = readdirSync(snapshotsDir);
  } catch {
    return 0; // dir does not exist yet
  }
  const prefix = `${sessionId}_`;
  let max = -1;
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(".ovdrjm")) continue;
    const index = Number(name.slice(prefix.length, -".ovdrjm".length));
    if (Number.isInteger(index) && index > max) max = index;
  }
  return max + 1;
}

/**
 * Copy the project's current .ovdrjm into the snapshots dir as
 * `{sessionId}_{index}.ovdrjm`. Raw byte copy preserves the original
 * UTF-16/UTF-8 encoding. Caller must ensure the level was saved to file first.
 * Returns the snapshot path.
 */
export function captureSnapshot(cwd: string, sessionId: string, index: number): string {
  const { ovdrjmPath } = resolveOvdrjmPathFromUmap(cwd);
  const dir = snapshotsDir(cwd);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${sessionId}_${index}.ovdrjm`);
  copyFileSync(ovdrjmPath, dest);
  return dest;
}

/**
 * Most recent snapshot in the project, by file mtime (matching the last agent
 * request). Throws if no snapshot exists.
 */
export function findLatestSnapshot(cwd: string): { id: string; path: string } {
  const dir = snapshotsDir(cwd);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  let newest: { name: string; mtimeMs: number } | undefined;
  for (const name of entries) {
    if (!name.endsWith(".ovdrjm")) continue;
    const mtimeMs = statSync(join(dir, name)).mtimeMs;
    if (!newest || mtimeMs > newest.mtimeMs) newest = { name, mtimeMs };
  }
  if (!newest) {
    throw new Error("No rollback snapshot found. Nothing to roll back.");
  }
  return { id: newest.name.slice(0, -".ovdrjm".length), path: join(dir, newest.name) };
}

/** Overwrite the project's current ovdrjm with the snapshot bytes. */
export function restoreSnapshot(cwd: string, snapshotPath: string): void {
  const { ovdrjmPath } = resolveOvdrjmPathFromUmap(cwd);
  copyFileSync(snapshotPath, ovdrjmPath);
}
