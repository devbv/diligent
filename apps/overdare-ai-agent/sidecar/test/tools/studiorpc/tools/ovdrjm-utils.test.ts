// @summary Verifies .ovdrjm document callbacks do not write partial mutations on failure.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAndWriteOvdrjm } from "../../../../src/tools/studiorpc/tools/ovdrjm-utils";

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readAndWriteOvdrjm", () => {
  test("leaves the original bytes unchanged when the mutation callback throws", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ovdrjm-atomic-"));
    createdDirs.push(cwd);
    writeFileSync(join(cwd, "World.umap"), "");
    const levelPath = join(cwd, "World.ovdrjm");
    writeFileSync(levelPath, '{"Root":{"ActorGuid":"W","Name":"Workspace"}}\r\n');
    const before = readFileSync(levelPath);

    expect(() =>
      readAndWriteOvdrjm(cwd, (document) => {
        (document.Root as Record<string, unknown>).Name = "PartiallyMutated";
        throw new Error("late failure");
      }),
    ).toThrow("late failure");

    expect(readFileSync(levelPath).equals(before)).toBe(true);
  });
});
