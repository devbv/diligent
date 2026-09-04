// @summary Tests structured editStatus metadata for studiorpc_script_edit success and edge cases.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("../../src/tools/studiorpc/rpc.ts", () => ({
  applyLevelChanges: async () => ({ ok: true }),
  call: async () => ({ ok: true }),
}));

const { createStudioRpcToolProvider } = await import("../../src/tools/studiorpc");

const createdDirs: string[] = [];
const scriptGuid = "s-guid-edit";

function makeScriptProject(source: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "sidecar-script-edit-"));
  writeFileSync(join(cwd, "Test.umap"), "");
  writeFileSync(
    join(cwd, "Test.ovdrjm"),
    JSON.stringify(
      {
        Root: {
          InstanceType: "Workspace",
          ActorGuid: "workspace",
          Name: "Workspace",
          LuaChildren: [
            {
              InstanceType: "Script",
              ActorGuid: scriptGuid,
              Name: "TestScript",
              Source: source,
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

async function getScriptEditTool(cwd: string) {
  const provider = createStudioRpcToolProvider({
    callRpc: async () => ({ ok: true }),
  });
  const tools = await provider.createTools({
    cwd,
    host: { approve: async () => "once" },
  });
  return tools.find((tool) => tool.name === "studiorpc_script_edit")!;
}

function toolContext() {
  return { toolCallId: "test", signal: new AbortController().signal, abort: () => {} };
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("studiorpc_script_edit editStatus metadata", () => {
  test("editStatus is edited and count is correct on successful replacement", async () => {
    const cwd = makeScriptProject('print("hello")\n');
    const tool = await getScriptEditTool(cwd);

    const result = await tool.execute(
      { targetGuid: scriptGuid, old_string: 'print("hello")', new_string: 'print("world")', replace_all: false },
      toolContext(),
    );

    expect(result.metadata).toMatchObject({ editStatus: "edited", count: 1 });
    expect(result.output).toContain("replaced 1 occurrence(s)");
  });

  test("editStatus is edited for replace_all across multiple occurrences", async () => {
    const cwd = makeScriptProject("x()\nx()\nx()\n");
    const tool = await getScriptEditTool(cwd);

    const result = await tool.execute(
      { targetGuid: scriptGuid, old_string: "x()", new_string: "y()", replace_all: true },
      toolContext(),
    );

    expect(result.metadata).toMatchObject({ editStatus: "edited", count: 3 });
    expect(result.output).toContain("replaced 3 occurrence(s)");
  });
});
