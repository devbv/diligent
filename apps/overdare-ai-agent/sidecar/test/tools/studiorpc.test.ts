// @summary Tests OVERDARE Studio bundled Studio RPC tool provider assembly.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@diligent/core/tool-contract";
import { createStudioBundledToolProviders } from "../../src/tools";
import { createStudioRpcToolProvider } from "../../src/tools/studiorpc";
import * as levelBrowse from "../../src/tools/studiorpc/methods/level.browse";
import { findNodeByActorGuid } from "../../src/tools/studiorpc/tools/ovdrjm-utils";

const createdDirs: string[] = [];

const workspaceGuid = "workspace-guid";
const folderGuid = "folder-guid";
const partGuid = "part-guid";
const statusOutputPattern = /^<studio_instance_status>\n(?<statusJson>[\s\S]*?)\n<\/studio_instance_status>\n/;

function makeStudioProject(): string {
  const cwd = join(tmpdir(), `sidecar-studiorpc-${process.pid}-${Date.now()}-${createdDirs.length}`);
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

async function loadStudioTools(
  cwd: string,
  rpcCalls: Array<{ method: string; params?: Record<string, unknown>; timeoutMs?: number }> = [],
): Promise<Map<string, Tool>> {
  const provider = createStudioRpcToolProvider({
    callRpc: async (method, params, options) => {
      rpcCalls.push({ method, params, timeoutMs: options?.timeoutMs });
      return { ok: true };
    },
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

function expectStatus(result: Awaited<ReturnType<Tool["execute"]>>, status: Record<string, unknown>) {
  expect(result.metadata).toMatchObject({
    error: true,
    method: status.operation,
    status,
  });
  const outputStatus = parseOutputStatus(result.output);
  expect(outputStatus).toMatchObject(status);
  expect(result.render).toMatchObject({
    outputSummary: status.code,
    blocks: [
      expect.objectContaining({ type: "key_value", title: "Studio instance status" }),
      expect.objectContaining({ type: "summary" }),
    ],
  });
}

function parseOutputStatus(output: string): Record<string, unknown> {
  const statusJson = statusOutputPattern.exec(output)?.groups?.statusJson;
  expect(statusJson).toBeDefined();
  return JSON.parse(statusJson!) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createStudioRpcToolProvider", () => {
  test("creates bundled Studio RPC tools with Zod schemas and plugin supersession", async () => {
    const providers = createStudioBundledToolProviders({ cwd: "/tmp/project" });
    const provider = providers.find((candidate) => candidate.id === "@overdare/studiorpc-tools");

    expect(provider).toBeDefined();
    expect(provider!.supersedesPluginPackages).toContain("@overdare/plugin-studiorpc");

    const tools = await provider!.createTools({ cwd: "/tmp/project" });
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toContain("studiorpc_instance_read");
    expect(toolNames).toContain("studiorpc_instance_upsert");
    expect(toolNames).toContain("studiorpc_script_edit");
    expect(toolNames).toContain("get_collision_channels");
    expect(toolNames).toContain("create_collision_profile");
    expect(toolNames).toContain("edit_collision_profile");
    expect(toolNames).toContain("hub_world_lookup");
    expect(toolNames).toContain("hub_world_categories_list");
    expect(toolNames).toContain("studiorpc_level_save_file");
    expect(toolNames).toContain("studiorpc_game_play");
    expect(toolNames).toContain("studio_playtest_smoke");

    const saveTool = tools.find((tool) => tool.name === "studiorpc_level_save_file")!;
    const hubLookupTool = tools.find((tool) => tool.name === "hub_world_lookup")!;
    const scriptEditTool = tools.find((tool) => tool.name === "studiorpc_script_edit")!;

    expect(() => saveTool.parameters.parse({})).not.toThrow();
    expect(() => tools.find((tool) => tool.name === "get_collision_profiles")!.parameters.parse({})).not.toThrow();
    expect(() => hubLookupTool.parameters.parse({ worldId: 123 })).not.toThrow();
    expect(scriptEditTool.description).toContain(
      "If an edit fails, call script_read to check the current source before retrying",
    );
    expect(scriptEditTool.description).toContain("call studiorpc_script_edit once per edited region");
    expect(scriptEditTool.description).toContain("apply them sequentially or choose non-overlapping");
  });

  test("accepts maxDepth 0 as unlimited for level browsing", async () => {
    const providers = createStudioBundledToolProviders({ cwd: "/tmp/project" });
    const provider = providers.find((candidate) => candidate.id === "@overdare/studiorpc-tools")!;
    const tools = await provider.createTools({ cwd: "/tmp/project" });
    const browseTool = tools.find((tool) => tool.name === "studiorpc_level_browse")!;

    expect(() => browseTool.parameters.parse({ maxDepth: 0 })).not.toThrow();
    expect(browseTool.parameters.parse({ maxDepth: 0 })).toMatchObject({ maxDepth: 0 });
  });

  test("treats maxDepth 0 and omitted maxDepth as unlimited after level browsing", () => {
    const tree = [
      {
        guid: "root",
        class: "Folder",
        children: [
          {
            guid: "part",
            class: "Part",
            children: [{ guid: "script", class: "Script" }],
          },
        ],
      },
    ];

    expect(levelBrowse.postProcess({ level: tree }, { maxDepth: 0 })).toEqual(tree);
    expect(levelBrowse.postProcess({ level: tree }, {})).toEqual(tree);
    expect(levelBrowse.postProcess({ level: tree }, { maxDepth: 1 })).toEqual([{ guid: "root", class: "Folder" }]);
  });

  test("preserves generic RPC approval rejection behavior without calling Studio", async () => {
    const providers = createStudioBundledToolProviders({ cwd: "/tmp/project" });
    const provider = providers.find((candidate) => candidate.id === "@overdare/studiorpc-tools")!;
    const tools = await provider.createTools({
      cwd: "/tmp/project",
      host: {
        approve: async () => "reject",
      },
    });
    const saveTool = tools.find((tool) => tool.name === "studiorpc_level_save_file")!;

    const result = await saveTool.execute(
      {},
      { toolCallId: "test", signal: new AbortController().signal, abort: () => {} },
    );

    expect(result).toEqual({
      output: "[Rejected by user]",
      metadata: { error: true, method: "level.save.file" },
    });
  });

  test("saves the Studio level at turn start and turn stop hooks", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const provider = createStudioRpcToolProvider({
      callRpc: async (method, params) => {
        calls.push({ method, params });
        return {};
      },
    });

    const studioRpcProvider = provider as typeof provider & {
      onUserPromptSubmit: NonNullable<typeof provider.onUserPromptSubmit>;
      onStop: NonNullable<typeof provider.onStop>;
    };

    expect(studioRpcProvider.onUserPromptSubmit.mode).toBe("sync");
    expect(studioRpcProvider.onStop.mode).toBe("sync");

    await studioRpcProvider.onUserPromptSubmit({
      session_id: "session-1",
      transcript_path: "/tmp/session.jsonl",
      cwd: "/tmp/project",
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
    });
    await studioRpcProvider.onStop({
      session_id: "session-1",
      transcript_path: "/tmp/session.jsonl",
      cwd: "/tmp/project",
      hook_event_name: "Stop",
    });

    expect(calls).toEqual([
      { method: "level.save.file", params: {} },
      { method: "level.save.file", params: {} },
    ]);
  });

  test("saves the level to file after a mutating asset-import tool call", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown>; timeoutMs?: number }> = [];
    const provider = createStudioRpcToolProvider({
      callRpc: async (method, params, options) => {
        calls.push({ method, params, timeoutMs: options?.timeoutMs });
        return "imported";
      },
    });
    const tools = await provider.createTools({
      cwd: "/tmp/project",
      host: { approve: async () => "once" },
    });
    const importTool = tools.find((tool) => tool.name === "studiorpc_asset_drawer_import")!;

    await importTool.execute(
      { assetid: "ovdrassetid://123", assetName: "Tree", assetType: "MODEL" },
      { toolCallId: "test", signal: new AbortController().signal, abort: () => {} },
    );

    expect(calls).toEqual([
      {
        method: "asset_drawer.import",
        params: { assetid: "ovdrassetid://123", assetName: "Tree", assetType: "MODEL" },
        timeoutMs: undefined,
      },
      { method: "level.save.file", params: {}, timeoutMs: undefined },
    ]);
  });

  test("uses an extended timeout and guidance for level publish", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown>; timeoutMs?: number }> = [];
    const tools = await loadStudioTools("/tmp/project", calls);
    const publishTool = tools.get("studiorpc_level_publish")!;

    expect(publishTool.description).toContain("click confirmation buttons");

    await publishTool.execute({ worldName: "My World" }, toolContext());

    expect(calls).toEqual([
      {
        method: "level.publish",
        params: { worldName: "My World" },
        timeoutMs: 300_000,
      },
    ]);
  });

  test("returns structured readback status when instance_read gets a missing target GUID", async () => {
    const cwd = makeStudioProject();
    const tools = await loadStudioTools(cwd);

    const result = await tools
      .get("studiorpc_instance_read")!
      .execute({ guid: "missing-target", recursive: false }, toolContext());

    expectStatus(result, {
      kind: "missing_guid",
      code: "missing_target_guid",
      operation: "instance.read",
      guid: "missing-target",
      role: "target",
      requiresReadback: true,
      suggestedTool: "studiorpc_level_browse",
    });
    expect(result.output).toContain("studiorpc_level_browse");
  });

  test("returns structured readback status for upsert missing target and parent GUIDs", async () => {
    const cwd = makeStudioProject();
    const rpcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const tools = await loadStudioTools(cwd, rpcCalls);
    const upsertTool = tools.get("studiorpc_instance_upsert")!;

    const updateResult = await upsertTool.execute(
      { items: [{ guid: "missing-target", properties: {} }] },
      toolContext(),
    );
    const addResult = await upsertTool.execute(
      { items: [{ class: "Folder", parentGuid: "missing-parent", name: "NewFolder", properties: {} }] },
      toolContext(),
    );

    expectStatus(updateResult, {
      kind: "missing_guid",
      code: "missing_target_guid",
      operation: "instance.upsert",
      guid: "missing-target",
      role: "target",
      requiresReadback: true,
      suggestedTool: "studiorpc_level_browse",
    });
    expectStatus(addResult, {
      kind: "missing_guid",
      code: "missing_parent_guid",
      operation: "instance.upsert",
      guid: "missing-parent",
      role: "parent",
      requiresReadback: true,
      suggestedTool: "studiorpc_level_browse",
    });
    expect(rpcCalls).toEqual([]);
  });

  test("reports ignored Mobility when upserting below a Workspace top-level object", async () => {
    const cwd = makeStudioProject();
    const tools = await loadStudioTools(cwd);
    const result = await tools.get("studiorpc_instance_upsert")!.execute(
      {
        items: [
          {
            class: "Part",
            parentGuid: folderGuid,
            name: "NestedPart",
            properties: { Mobility: "Static" },
          },
        ],
      },
      toolContext(),
    );

    expect(result.metadata?.info).toEqual([
      expect.stringMatching(/^Ignored Mobility for .+: Mobility can only be changed on a direct child of Workspace\.$/),
    ]);
    expect(result.output).toContain("<suggestions>");
    expect(result.output).toContain("Ignored Mobility");
  });

  test("returns structured readback status for move missing target and new parent GUIDs", async () => {
    const cwd = makeStudioProject();
    const rpcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const tools = await loadStudioTools(cwd, rpcCalls);
    const moveTool = tools.get("studiorpc_instance_move")!;

    const targetResult = await moveTool.execute(
      { items: [{ guid: "missing-target", parentGuid: folderGuid }] },
      toolContext(),
    );
    const parentResult = await moveTool.execute(
      { items: [{ guid: partGuid, parentGuid: "missing-parent" }] },
      toolContext(),
    );

    expectStatus(targetResult, {
      kind: "missing_guid",
      code: "missing_target_guid",
      operation: "instance.move",
      guid: "missing-target",
      role: "target",
      requiresReadback: true,
      suggestedTool: "studiorpc_level_browse",
    });
    expectStatus(parentResult, {
      kind: "missing_guid",
      code: "missing_new_parent_guid",
      operation: "instance.move",
      guid: "missing-parent",
      role: "new_parent",
      requiresReadback: true,
      suggestedTool: "studiorpc_level_browse",
    });
    expect(rpcCalls).toEqual([]);
  });

  test("returns structured readback status when instance_delete gets a missing target GUID", async () => {
    const cwd = makeStudioProject();
    const rpcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const tools = await loadStudioTools(cwd, rpcCalls);

    const result = await tools
      .get("studiorpc_instance_delete")!
      .execute({ items: [{ targetGuid: "missing-target" }] }, toolContext());

    expectStatus(result, {
      kind: "missing_guid",
      code: "missing_target_guid",
      operation: "instance.delete",
      guid: "missing-target",
      role: "target",
      requiresReadback: true,
      suggestedTool: "studiorpc_level_browse",
    });
    expect(rpcCalls).toEqual([]);
  });

  test("returns invalid_operation status for protected service move and delete", async () => {
    const cwd = makeStudioProject();
    const rpcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const tools = await loadStudioTools(cwd, rpcCalls);

    const moveResult = await tools
      .get("studiorpc_instance_move")!
      .execute({ items: [{ guid: workspaceGuid, parentGuid: folderGuid }] }, toolContext());
    const deleteResult = await tools
      .get("studiorpc_instance_delete")!
      .execute({ items: [{ targetGuid: workspaceGuid }] }, toolContext());

    expectStatus(moveResult, {
      kind: "invalid_operation",
      code: "protected_service_class",
      operation: "instance.move",
      guid: workspaceGuid,
      role: "target",
      class: "Workspace",
      requiresReadback: false,
    });
    expectStatus(deleteResult, {
      kind: "invalid_operation",
      code: "protected_service_class",
      operation: "instance.delete",
      guid: workspaceGuid,
      role: "target",
      class: "Workspace",
      requiresReadback: false,
    });
    expect(rpcCalls).toEqual([]);
  });

  test("returns invalid_operation status for a hierarchy cycle", async () => {
    const cwd = makeStudioProject();
    const rpcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const tools = await loadStudioTools(cwd, rpcCalls);

    const result = await tools
      .get("studiorpc_instance_move")!
      .execute({ items: [{ guid: partGuid, parentGuid: partGuid }] }, toolContext());

    expectStatus(result, {
      kind: "invalid_operation",
      code: "hierarchy_cycle",
      operation: "instance.move",
      guid: partGuid,
      role: "target",
      requiresReadback: false,
    });
    expect(rpcCalls).toEqual([]);
  });

  test("instance_move re-normalizes Mobility when a node's top-level ancestor changes", async () => {
    const cwd = makeStudioProject();
    const tools = await loadStudioTools(cwd);
    const upsert = tools.get("studiorpc_instance_upsert")!;
    // Both Folder and Part are direct children of Workspace, so their Mobility is authoritative.
    await upsert.execute({ items: [{ guid: folderGuid, properties: { Mobility: "Movable" } }] }, toolContext());
    await upsert.execute({ items: [{ guid: partGuid, properties: { Mobility: "Static" } }] }, toolContext());

    // Moving the Part under the (Movable) Folder demotes it to a descendant that must follow the Folder.
    await tools
      .get("studiorpc_instance_move")!
      .execute({ items: [{ guid: partGuid, parentGuid: folderGuid }] }, toolContext());

    const doc = JSON.parse(readFileSync(join(cwd, "Test.ovdrjm"), "utf-8")) as {
      Root: Parameters<typeof findNodeByActorGuid>[0];
    };
    expect(findNodeByActorGuid(doc.Root, partGuid)?.Mobility).toBe("Movable");
  });
});
