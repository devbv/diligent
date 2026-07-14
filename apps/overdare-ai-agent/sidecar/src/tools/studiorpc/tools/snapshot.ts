// @summary Rollback snapshot helpers: capture/restore .ovdrjm level snapshots with metadata.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "@diligent/runtime";
import { resolveOvdrjmPathFromUmap } from "./ovdrjm-utils";

export type SnapshotKind = "turn" | "pre-rollback";

/** Metadata stored in the `{id}.json` sidecar next to each snapshot. */
export interface SnapshotMeta {
  id: string;
  sessionId: string;
  index: number;
  createdAt: string;
  label?: string;
  kind: SnapshotKind;
}

/** A snapshot on disk: sidecar metadata plus the path to the .ovdrjm copy. */
export interface SnapshotEntry extends SnapshotMeta {
  path: string;
}

export interface CaptureOptions {
  label?: string;
  kind?: SnapshotKind;
}

/**
 * Directory holding rollback snapshots, under the project's storage-namespace
 * dir (`.overdare/snapshots` in prod, `.diligent/snapshots` in dev). Uses
 * resolvePaths so the namespace and dot-prefix follow the project convention.
 */
export function snapshotsDir(cwd: string): string {
  return join(resolvePaths(cwd).root, "snapshots");
}

/**
 * Fixed per-project baseline captured when the agent finishes a turn. Diffing
 * it against the current .ovdrjm reveals what the human edited in between.
 * Lives in the snapshots dir but is excluded from rollback selection.
 */
const BASELINE_FILENAME = "agent-done-baseline.ovdrjm";

export function baselinePath(cwd: string): string {
  return join(snapshotsDir(cwd), BASELINE_FILENAME);
}

/** Copy the current .ovdrjm to the fixed agent-done baseline (raw bytes, overwrite). */
export function captureBaseline(cwd: string): string {
  const { ovdrjmPath } = resolveOvdrjmPathFromUmap(cwd);
  mkdirSync(snapshotsDir(cwd), { recursive: true });
  const dest = baselinePath(cwd);
  copyFileSync(ovdrjmPath, dest);
  return dest;
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
 * `{sessionId}_{index}.ovdrjm` and write a `{sessionId}_{index}.json` metadata
 * sidecar (label, kind, createdAt). Raw byte copy preserves the original
 * UTF-16/UTF-8 encoding. Caller must ensure the level was saved to file first.
 * Returns the snapshot path.
 */
export function captureSnapshot(cwd: string, sessionId: string, index: number, options: CaptureOptions = {}): string {
  const { ovdrjmPath } = resolveOvdrjmPathFromUmap(cwd);
  const dir = snapshotsDir(cwd);
  mkdirSync(dir, { recursive: true });
  const id = `${sessionId}_${index}`;
  const dest = join(dir, `${id}.ovdrjm`);
  copyFileSync(ovdrjmPath, dest);
  const meta: SnapshotMeta = {
    id,
    sessionId,
    index,
    createdAt: new Date().toISOString(),
    ...(options.label !== undefined ? { label: options.label } : {}),
    kind: options.kind ?? "turn",
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(meta));
  return dest;
}

/** Parse `{sessionId}_{index}` from a snapshot filename; sessionId may itself contain underscores. */
function parseSnapshotName(name: string): { sessionId: string; index: number } | undefined {
  const stem = name.slice(0, -".ovdrjm".length);
  const sep = stem.lastIndexOf("_");
  if (sep <= 0) return undefined;
  const index = Number(stem.slice(sep + 1));
  if (!Number.isInteger(index)) return undefined;
  return { sessionId: stem.slice(0, sep), index };
}

/**
 * All snapshots in the project, newest first (by file mtime). Snapshots
 * predating the metadata sidecar are listed with kind "turn", no label, and an
 * mtime-derived createdAt so old projects keep working.
 */
export function listSnapshots(cwd: string): SnapshotEntry[] {
  const dir = snapshotsDir(cwd);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: Array<SnapshotEntry & { mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".ovdrjm")) continue;
    const parsed = parseSnapshotName(name);
    if (!parsed) continue;
    const path = join(dir, name);
    const mtimeMs = statSync(path).mtimeMs;
    const id = name.slice(0, -".ovdrjm".length);
    let meta: SnapshotMeta | undefined;
    try {
      meta = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf-8")) as SnapshotMeta;
    } catch {
      // legacy snapshot without metadata sidecar
    }
    entries.push({
      id,
      path,
      sessionId: parsed.sessionId,
      index: parsed.index,
      createdAt: meta?.createdAt ?? new Date(mtimeMs).toISOString(),
      ...(meta?.label !== undefined ? { label: meta.label } : {}),
      kind: meta?.kind ?? "turn",
      mtimeMs,
    });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.map(({ mtimeMs: _mtimeMs, ...entry }) => entry);
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
    // The agent-done baseline is rewritten every turn, so by mtime it would
    // always win — it is a diff baseline, never a rollback target.
    if (!name.endsWith(".ovdrjm") || name === BASELINE_FILENAME) continue;
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
