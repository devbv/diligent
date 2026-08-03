// @summary Regression tests for shared script add/delete document mutations.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addScriptToDocument,
  deleteScriptFromDocument,
} from "../../../../src/tools/studiorpc/tools/script-document-operations";

const createdDirs: string[] = [];

function makeProject(): string {
  const cwd = join(tmpdir(), `script-document-operations-${process.pid}-${Date.now()}-${createdDirs.length}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "Test.umap"), "");
  writeFileSync(
    join(cwd, "Test.ovdrjm"),
    JSON.stringify(
      {
        MapObjectKeyIndex: 7,
        Root: {
          InstanceType: "Workspace",
          ActorGuid: "workspace",
          LuaChildren: [
            {
              InstanceType: "StarterPlayerScripts",
              ActorGuid: "scripts",
              LuaChildren: [],
            },
            {
              InstanceType: "Part",
              ActorGuid: "part",
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  createdDirs.push(cwd);
  return cwd;
}

function readDocument(cwd: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cwd, "Test.ovdrjm"), "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("script document operations", () => {
  test("adds and removes a LocalScript while preserving the existing document contract", () => {
    const cwd = makeProject();

    const added = addScriptToDocument(
      cwd,
      {
        class: "LocalScript",
        parentGuid: "scripts",
        name: "Observer",
        source: "    print('ready')\n",
      },
      () => "observer-guid",
    );

    expect(added).toMatchObject({ guid: "observer-guid", normalizedLeadingSpaceGroups: 1 });
    expect(JSON.stringify(readDocument(cwd))).toContain(
      '"InstanceType":"LocalScript","ActorGuid":"observer-guid","ObjectKey":8,"Name":"Observer",' +
        '"Archivable":true,"bDisableAdaptiveNetUpdateFrequency":false,"Mobility":"Movable","Enabled":true,' +
        `"Source":"\\tprint('ready')\\r\\n"`,
    );
    expect(readDocument(cwd).MapObjectKeyIndex).toBe(8);

    deleteScriptFromDocument(cwd, "observer-guid");

    expect(JSON.stringify(readDocument(cwd))).not.toContain("observer-guid");
    expect(readDocument(cwd).MapObjectKeyIndex).toBe(8);
  });

  test("does not delete non-script instances", () => {
    const cwd = makeProject();
    const before = readFileSync(join(cwd, "Test.ovdrjm"), "utf8");

    expect(() => deleteScriptFromDocument(cwd, "part")).toThrow("not a script");
    expect(readFileSync(join(cwd, "Test.ovdrjm"), "utf8")).toBe(before);
  });
});
