// @summary Tests levelApplyStatus metadata in Studio mutation tools with mocked level.apply RPC.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const applyLevelChangesMock = mock(async (): Promise<unknown> => ({ ok: true }));

mock.module("../../src/tools/studiorpc/rpc.ts", () => ({
  applyLevelChanges: applyLevelChangesMock,
  call: async () => ({ ok: true }),
}));

const { createStudioRpcToolProvider } = await import("../../src/tools/studiorpc");

const workspaceGuid = "workspace-guid";
const folderGuid = "folder-guid";
const partGuid = "part-guid";

const createdDirs: string[] = [];

function makeStudioProject(): string {
  const cwd = join(tmpdir(), `sidecar-levelapply-${process.pid}-${Date.now()}-${createdDirs.length}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "Test.umap"), "");
  writeFileSync(
    join(cwd, "Test.ovdrjm"),
    JSON.stringify(
      {
        Root: {
          InstanceType: "Workspace",
          ActorGuid: workspaceGuid,
          Name: "Workspace",
          LuaChildren: [
            { InstanceType: "Folder", ActorGuid: folderGuid, Name: "Folder", LuaChildren: [] },
            { InstanceType: "Part", ActorGuid: partGuid, Name: "Part" },
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

async function loadTools(cwd: string) {
  const provider = createStudioRpcToolProvider({
    callRpc: async () => ({ ok: true }),
  });
  const tools = await provider.createTools({
    cwd,
    host: { approve: async () => "once" },
  });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function toolContext() {
  return { toolCallId: "test", signal: new AbortController().signal, abort: () => {} };
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  applyLevelChangesMock.mockReset();
  applyLevelChangesMock.mockImplementation(async () => ({ ok: true }));
});

describe("instance_move levelApplyStatus", () => {
  test("partial when level.apply returns success:false with warnings", async () => {
    const cwd = makeStudioProject();
    applyLevelChangesMock.mockImplementation(async () => ({
      success: false,
      warnings: ["VFXPreset could not bind to moved actor", "Material slot missing"],
    }));

    const tools = await loadTools(cwd);
    const result = await tools
      .get("studiorpc_instance_move")!
      .execute({ items: [{ guid: partGuid, parentGuid: folderGuid }] }, toolContext());

    expect(result.metadata).toMatchObject({
      method: "instance.move",
      levelApplyResult: { success: false, warnings: expect.any(Array) },
      levelApplyStatus: {
        kind: "partial",
        warnings: ["VFXPreset could not bind to moved actor", "Material slot missing"],
        requiresReadback: true,
      },
    });
  });

  test("applied_with_warnings when level.apply returns success:true with warnings", async () => {
    const cwd = makeStudioProject();
    applyLevelChangesMock.mockImplementation(async () => ({
      success: true,
      warnings: ["Minor VFX binding issue"],
    }));

    const tools = await loadTools(cwd);
    const result = await tools
      .get("studiorpc_instance_move")!
      .execute({ items: [{ guid: partGuid, parentGuid: folderGuid }] }, toolContext());

    expect(result.metadata).toMatchObject({
      method: "instance.move",
      levelApplyStatus: { kind: "applied_with_warnings", warnings: ["Minor VFX binding issue"] },
    });
  });

  test("applied for clean success:true", async () => {
    const cwd = makeStudioProject();
    applyLevelChangesMock.mockImplementation(async () => ({ success: true }));

    const tools = await loadTools(cwd);
    const result = await tools
      .get("studiorpc_instance_move")!
      .execute({ items: [{ guid: partGuid, parentGuid: folderGuid }] }, toolContext());

    expect(result.metadata).toMatchObject({
      method: "instance.move",
      levelApplyStatus: { kind: "applied" },
    });
  });
});

describe("instance_delete levelApplyStatus", () => {
  test("failed when level.apply returns success:false with errors", async () => {
    const cwd = makeStudioProject();
    applyLevelChangesMock.mockImplementation(async () => ({
      success: false,
      errors: ["Cannot resolve reference for deleted actor"],
    }));

    const tools = await loadTools(cwd);
    const result = await tools
      .get("studiorpc_instance_delete")!
      .execute({ items: [{ targetGuid: partGuid }] }, toolContext());

    expect(result.metadata).toMatchObject({
      method: "instance.delete",
      levelApplyResult: { success: false, errors: expect.any(Array) },
      levelApplyStatus: {
        kind: "failed",
        errors: ["Cannot resolve reference for deleted actor"],
      },
    });
  });

  test("partial when level.apply returns success:false with warnings", async () => {
    const cwd = makeStudioProject();
    applyLevelChangesMock.mockImplementation(async () => ({
      success: false,
      warnings: ["SoftLink reference dangling"],
    }));

    const tools = await loadTools(cwd);
    const result = await tools
      .get("studiorpc_instance_delete")!
      .execute({ items: [{ targetGuid: partGuid }] }, toolContext());

    expect(result.metadata).toMatchObject({
      method: "instance.delete",
      levelApplyStatus: { kind: "partial", requiresReadback: true },
    });
  });
});

describe("instance_upsert levelApplyStatus", () => {
  test("captures levelApplyResult and levelApplyStatus=applied for success:true", async () => {
    const cwd = makeStudioProject();
    applyLevelChangesMock.mockImplementation(async () => ({ success: true }));

    const tools = await loadTools(cwd);
    const result = await tools
      .get("studiorpc_instance_upsert")!
      .execute({ items: [{ parentGuid: folderGuid, class: "Part", name: "NewPart", properties: {} }] }, toolContext());

    expect(result.metadata).toMatchObject({
      method: "instance.upsert",
      levelApplyResult: { success: true },
      levelApplyStatus: { kind: "applied" },
    });
  });

  test("levelApplyStatus=partial for success:false with warnings (upsert may have applied)", async () => {
    const cwd = makeStudioProject();
    applyLevelChangesMock.mockImplementation(async () => ({
      success: false,
      warnings: ["MaterialService binding not found"],
    }));

    const tools = await loadTools(cwd);
    const result = await tools
      .get("studiorpc_instance_upsert")!
      .execute({ items: [{ parentGuid: folderGuid, class: "Part", name: "NewPart", properties: {} }] }, toolContext());

    expect(result.metadata).toMatchObject({
      method: "instance.upsert",
      levelApplyResult: { success: false },
      levelApplyStatus: { kind: "partial", requiresReadback: true },
    });
  });

  test("levelApplyResult is present even for update (not add) operations", async () => {
    const cwd = makeStudioProject();
    applyLevelChangesMock.mockImplementation(async () => ({ success: true }));

    const tools = await loadTools(cwd);
    const result = await tools
      .get("studiorpc_instance_upsert")!
      .execute({ items: [{ guid: partGuid, name: "RenamedPart", properties: {} }] }, toolContext());

    expect(result.metadata).toMatchObject({
      method: "instance.upsert",
      levelApplyResult: { success: true },
      levelApplyStatus: { kind: "applied" },
    });
  });
});
