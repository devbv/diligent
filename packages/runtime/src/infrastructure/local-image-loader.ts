// @summary Runtime filesystem adapter for persisted local-image blocks

import { readFile } from "node:fs/promises";
import { isAbsolute, normalize, posix, resolve } from "node:path";
import type { LocalImageLoader } from "@diligent/core/image-contract";

function normalizeSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

export function toPersistedLocalImagePath(absPath: string, cwd: string): string {
  const normalizedAbsolute = normalize(absPath);
  const normalizedCwd = normalize(cwd);
  if (normalizedAbsolute.startsWith(normalizedCwd)) {
    const relative = normalizedAbsolute.slice(normalizedCwd.length).replace(/^[/\\]+/, "");
    if (relative.length > 0) return normalizeSeparators(relative);
  }
  return normalizeSeparators(normalizedAbsolute);
}

export function resolvePersistedLocalImagePath(path: string, cwd?: string): string {
  if (path.startsWith("/")) return normalizeSeparators(path);
  if (isAbsolute(path) || !cwd) return normalize(path);
  if (cwd.includes("/") && !cwd.includes("\\")) return posix.resolve(cwd, normalizeSeparators(path));
  return resolve(cwd, path);
}

export function createLocalImageLoader(cwd: string): LocalImageLoader {
  return {
    async load(block) {
      try {
        const bytes = await readFile(resolvePersistedLocalImagePath(block.path, cwd));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}
