// @summary Captures and validates isolated runtime eval workspaces

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RuntimeWorkspaceEntry, RuntimeWorldSnapshot } from "../runtime-task";

export async function captureWorkspace(root: string): Promise<RuntimeWorldSnapshot> {
  const safeRoot = validateTemporaryRoot(root);
  const entries: RuntimeWorkspaceEntry[] = [];
  await walk(safeRoot, safeRoot, entries);
  return { entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
}

export function resolveWorkspacePath(root: string, candidate: string): string {
  const safeRoot = validateTemporaryRoot(root);
  if (/^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\"))
    throw new Error(`runtime_contract.workspace_escape: incompatible absolute path: ${candidate}`);
  const normalized = candidate.replaceAll("\\", "/");
  const resolved = isAbsolute(normalized) ? resolve(normalized) : resolve(safeRoot, normalized);
  const comparableRoot = normalizePlatformAlias(safeRoot);
  const comparableResolved = normalizePlatformAlias(resolved);
  if (comparableResolved !== comparableRoot && !comparableResolved.startsWith(`${comparableRoot}${sep}`)) {
    throw new Error(`runtime_contract.workspace_escape: path leaves workspace: ${candidate}`);
  }
  return resolved;
}

export function normalizePlatformAlias(path: string): string {
  return process.platform === "darwin" && path.startsWith("/private/var/") ? path.slice("/private".length) : path;
}

export function validateTemporaryRoot(root: string): string {
  if (!root || !isAbsolute(root)) throw new Error("Runtime eval root must be an absolute resolved path.");
  const resolved = resolve(root);
  const broad = new Set([resolve("/"), resolve(homedir()), resolve(process.cwd())]);
  if (broad.has(resolved) || resolved.length < 8) throw new Error(`Refusing broad runtime eval root: ${resolved}`);
  return resolved;
}

export async function removeTemporaryRoot(root: string): Promise<void> {
  await rm(validateTemporaryRoot(root), { recursive: true, force: true });
}

export function workspaceDiff(initial: RuntimeWorldSnapshot, final: RuntimeWorldSnapshot) {
  const before = new Map(initial.entries.map((entry) => [entry.path, entry]));
  const after = new Map(final.entries.map((entry) => [entry.path, entry]));
  const changed = new Set<string>();
  let changedBytes = 0;
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(path);
    const right = after.get(path);
    if (JSON.stringify(left) === JSON.stringify(right) || left?.kind === "directory" || right?.kind === "directory")
      continue;
    changed.add(path);
    changedBytes += right?.size ?? 0;
  }
  return { changedFiles: [...changed].sort(), changedBytes };
}

async function walk(root: string, dir: string, output: RuntimeWorkspaceEntry[]): Promise<void> {
  for (const name of await readdir(dir)) {
    const absolute = resolve(dir, name);
    const path = relative(root, absolute).split(sep).join("/");
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      output.push({ path, kind: "symlink", size: stat.size });
      continue;
    }
    if (stat.isDirectory()) {
      output.push({ path, kind: "directory", size: 0 });
      await walk(root, absolute, output);
      continue;
    }
    const content = await readFile(absolute);
    output.push({
      path,
      kind: "file",
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      executable: (stat.mode & 0o111) !== 0,
    });
  }
}
