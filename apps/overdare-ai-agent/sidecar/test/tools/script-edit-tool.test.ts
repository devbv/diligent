// @summary Verifies Studio script edits are persisted and read back before success is reported.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptEditTool } from "../../src/tools/studiorpc/tools/script-edit-tool";
import { createWriteLock } from "../../src/tools/studiorpc/write-lock";

const createdDirs: string[] = [];
const scriptGuid = "script-guid";

function makeStudioProject(source = "print('before')\n"): string {
  const cwd = join(tmpdir(), `sidecar-script-edit-${process.pid}-${Date.now()}-${createdDirs.length}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "Test.umap"), "");
  writeFileSync(
    join(cwd, "Test.ovdrjm"),
    JSON.stringify({
      Root: {
        InstanceType: "Workspace",
        ActorGuid: "workspace",
        LuaChildren: [{ InstanceType: "Script", ActorGuid: scriptGuid, Name: "Main", Source: source }],
      },
    }),
  );
  createdDirs.push(cwd);
  return cwd;
}

function toolContext() {
  return {
    toolCallId: "test",
    signal: new AbortController().signal,
    abort: () => {},
    approve: async () => "once" as const,
  };
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("studiorpc_script_edit", () => {
  test("reports success only after apply/save and a matching source readback", async () => {
    const cwd = makeStudioProject();
    const calls: string[] = [];
    const tool = createScriptEditTool(cwd, createWriteLock(), async () => {
      calls.push("level.apply");
      calls.push("level.save.file");
    });

    const result = await tool.execute(
      { targetGuid: scriptGuid, old_string: "before", new_string: "after" } as never,
      toolContext(),
    );

    expect(calls).toEqual(["level.apply", "level.save.file"]);
    expect(result.output).toContain("replaced 1 occurrence(s); readback verified");
    expect(result.metadata).toMatchObject({
      count: 1,
      readback: { verified: true, sourceChanged: true },
    });
  });

  test("fails when the saved Studio state does not contain the requested edit", async () => {
    const cwd = makeStudioProject();
    const tool = createScriptEditTool(cwd, createWriteLock(), async () => {
      const path = join(cwd, "Test.ovdrjm");
      writeFileSync(path, readFileSync(path, "utf8").replace("after", "before"));
    });

    const result = await tool.execute(
      { targetGuid: scriptGuid, old_string: "before", new_string: "after" } as never,
      toolContext(),
    );

    expect(result.metadata).toMatchObject({ error: true });
    expect(result.output).toContain("Post-edit readback did not match");
  });
});
