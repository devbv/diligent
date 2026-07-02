// @summary Tests OVERDARE Studio bundled Studio RPC tool provider assembly.

import { describe, expect, test } from "bun:test";
import { createStudioBundledToolProviders } from "../../src/tools";
import { createStudioRpcToolProvider } from "../../src/tools/studiorpc";
import * as levelBrowse from "../../src/tools/studiorpc/methods/level.browse";

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
      stop_hook_active: false,
    });

    expect(calls).toEqual([
      { method: "level.save.file", params: {} },
      { method: "level.save.file", params: {} },
    ]);
  });

  test("does not save after individual mutating Studio RPC tool calls", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const provider = createStudioRpcToolProvider({
      callRpc: async (method, params) => {
        calls.push({ method, params });
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
      },
    ]);
  });
});
