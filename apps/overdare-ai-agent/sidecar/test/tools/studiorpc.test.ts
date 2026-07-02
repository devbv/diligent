// @summary Tests OVERDARE Studio bundled Studio RPC tool provider assembly.

import { describe, expect, test } from "bun:test";
import { createStudioBundledToolProviders } from "../../src/tools";
import { createStudioRpcToolProvider } from "../../src/tools/studiorpc";
import { parseArgs as parseInstanceUpsertArgs } from "../../src/tools/studiorpc/methods/instance.upsert";
import * as levelBrowse from "../../src/tools/studiorpc/methods/level.browse";

function thrownMessage(fn: () => void): string {
  return thrownError(fn).message;
}

function thrownError(fn: () => void): Error & { invalidArgs?: Record<string, unknown> } {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err as Error & { invalidArgs?: Record<string, unknown> };
    throw new Error(String(err));
  }
  throw new Error("Expected function to throw.");
}

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

  test("adds correction hints for common instance upsert property shape mistakes", () => {
    const partError = thrownMessage(() =>
      parseInstanceUpsertArgs({
        items: [
          {
            class: "Part",
            parentGuid: "parent",
            name: "BadColorPart",
            properties: { BaseColorR: 255, BaseColorG: 128, BaseColorB: 0 },
          },
        ],
      }),
    );

    expect(partError).toContain("[items[0].properties]");
    expect(partError).toContain("Suggested fix: replace BaseColorR/BaseColorG/BaseColorB with Color: { R, G, B }");

    const particleError = thrownMessage(() =>
      parseInstanceUpsertArgs({
        items: [
          {
            class: "ParticleEmitter",
            parentGuid: "parent",
            name: "BadEmitter",
            properties: {
              Color: { R: 255, G: 128, B: 0 },
              Size: { Min: 1, Max: 2 },
            },
          },
        ],
      }),
    );

    expect(particleError).toContain("[items[0].properties.Color]");
    expect(particleError).toContain("Suggested fix: Color must be a ColorSequence array");
    expect(particleError).toContain("[items[0].properties.Size]");
    expect(particleError).toContain("Suggested fix: Size must be a NumberSequence array");

    const promptError = thrownMessage(() =>
      parseInstanceUpsertArgs({
        items: [
          {
            class: "ProximityPrompt",
            parentGuid: "parent",
            name: "BadPrompt",
            properties: {},
          },
        ],
      }),
    );

    expect(promptError).toContain("[items[0].properties.KeyboardKeyCode]");
    expect(promptError).toContain("Suggested fix: include required ProximityPrompt fields");
    expect(promptError).toContain("[items[0].properties.ActionText]");
    expect(promptError).toContain("[items[0].properties.ObjectText]");
  });

  test("preserves structured invalid args metadata for instance upsert hints", () => {
    const error = thrownError(() =>
      parseInstanceUpsertArgs({
        items: [
          {
            class: "ParticleEmitter",
            parentGuid: "parent",
            name: "BadEmitter",
            properties: {
              Color: { R: 255, G: 128, B: 0 },
              Size: { Min: 1, Max: 2 },
            },
          },
        ],
      }),
    );

    expect(error.invalidArgs).toMatchObject({
      status: { kind: "invalid_args" },
      code: "invalid_args",
      issues: [
        {
          path: "items[0].properties.Color",
          code: "invalid_type",
          suggestedFix:
            "Color must be a ColorSequence array, e.g. Color: [{ Time: 0, Color: { R: 255, G: 255, B: 255 } }].",
        },
        {
          path: "items[0].properties.Size",
          code: "invalid_type",
          suggestedFix: "Size must be a NumberSequence array, e.g. Size: [{ Time: 0, Value: 1 }].",
        },
      ],
    });
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
