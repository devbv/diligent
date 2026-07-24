// @summary Enforces structured logging for first-party web diagnostics and preserves the port contract.

import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : Promise.resolve([path]);
    }),
  );
  return nested.flat().filter((path) => /\.[cm]?[jt]sx?$/.test(path));
}

test("web-host diagnostics use structured loggers", async () => {
  const sourceRoot = join(import.meta.dir, "../../src/web");
  const consoleCalls: Array<{ path: string; call: string }> = [];

  for (const path of await sourceFiles(sourceRoot)) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/console\.(?:debug|info|warn|error)\([^\n]*/g)) {
      consoleCalls.push({ path: path.slice(sourceRoot.length + 1), call: match[0] });
    }
  }

  expect(consoleCalls).toEqual([]);
});
