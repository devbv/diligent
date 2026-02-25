import { existsSync } from "fs";
import { dirname, join, resolve } from "path";

/**
 * Find the .diligent/ directory by walking up from cwd.
 * With --sample flag, returns the sample data directory instead.
 */
export function findDiligentDir(options: { sample?: boolean; cwd?: string } = {}): string | null {
  if (options.sample) {
    return resolve(dirname(new URL(import.meta.url).pathname), "sample-data");
  }

  let dir = options.cwd ?? process.cwd();
  while (true) {
    const candidate = join(dir, ".diligent");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}
