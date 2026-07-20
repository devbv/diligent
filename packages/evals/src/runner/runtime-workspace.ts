// @summary Captures and validates isolated runtime eval workspaces

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import type { RuntimeWorkspaceEntry, RuntimeWorldSnapshot } from "../runtime-task";

export async function captureWorkspace(root: string): Promise<RuntimeWorldSnapshot> {
  const safeRoot = validateTemporaryRoot(root);
  const entries: RuntimeWorkspaceEntry[] = [];
  await walk(safeRoot, safeRoot, entries);
  return { entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function canonicalizeTemporaryRoot(root: string): Promise<string> {
  return validateTemporaryRoot(await realpath(validateTemporaryRoot(root)));
}

export function resolveWorkspacePath(root: string, candidate: string): string {
  const safeRoot = validateTemporaryRoot(root);
  return resolveWorkspacePathForFlavor(safeRoot, candidate, process.platform === "win32" ? "win32" : "posix");
}

export function resolveWorkspacePathForFlavor(root: string, candidate: string, flavor: "posix" | "win32"): string {
  const path = flavor === "win32" ? win32 : posix;
  if (!path.isAbsolute(root)) throw new Error(`Runtime eval root must be an absolute ${flavor} path.`);
  if (flavor === "posix" && (/^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\")))
    throw new Error(`runtime_contract.workspace_escape: incompatible absolute path: ${candidate}`);
  const normalized = flavor === "posix" ? candidate.replaceAll("\\", "/") : candidate;
  const resolved = path.resolve(root, normalized);
  const comparableRoot = flavor === "posix" ? normalizePlatformAlias(root) : root;
  const comparableResolved = flavor === "posix" ? normalizePlatformAlias(resolved) : resolved;
  const relativePath = path.relative(comparableRoot, comparableResolved);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`runtime_contract.workspace_escape: path leaves workspace: ${candidate}`);
  }
  return resolved;
}

export function normalizePlatformAlias(path: string): string {
  return process.platform === "darwin" && (path.startsWith("/private/var/") || path.startsWith("/private/tmp/"))
    ? path.slice("/private".length)
    : path;
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
