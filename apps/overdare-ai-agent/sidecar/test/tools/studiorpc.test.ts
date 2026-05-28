// @summary Tests OVERDARE Studio bundled Studio RPC tool provider assembly.

import { describe, expect, test } from "bun:test";
import { createStudioBundledToolProviders } from "../../src/tools";

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
    expect(toolNames).toContain("hub_world_lookup");
    expect(toolNames).toContain("hub_world_categories_list");
    expect(toolNames).toContain("studiorpc_level_save_file");
    expect(toolNames).toContain("studiorpc_game_play");

    const saveTool = tools.find((tool) => tool.name === "studiorpc_level_save_file")!;
    const hubLookupTool = tools.find((tool) => tool.name === "hub_world_lookup")!;

    expect(() => saveTool.parameters.parse({})).not.toThrow();
    expect(() => hubLookupTool.parameters.parse({ worldId: 123 })).not.toThrow();
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
});
