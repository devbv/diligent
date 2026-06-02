// @summary Tests default tool assembly gating for provider-native web tools
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { BundledToolProvider } from "../../src/tools/bundled-provider";
import { buildDefaultTools } from "../../src/tools/defaults";

describe("buildDefaultTools web gating", () => {
  test("includes provider-native web placeholder tool by default", async () => {
    const result = await buildDefaultTools({ cwd: "/tmp" });
    const names = result.tools.map((tool) => tool.name);

    expect(names).toContain("web_action");
  });

  test("omits provider-native web placeholder tool when tools.web_action is false", async () => {
    const result = await buildDefaultTools({ cwd: "/tmp", toolsConfig: { web_action: false } });
    const names = result.tools.map((tool) => tool.name);

    expect(names).not.toContain("web_action");
    expect(result.toolState.find((entry) => entry.name === "web_action")).toBeUndefined();
  });

  test("includes bundled provider tools in the default tool catalog", async () => {
    const provider: BundledToolProvider = {
      id: "@product/default-tools",
      createTools: () => [
        {
          name: "bundled_default_tool",
          description: "Bundled default tool",
          parameters: z.object({}),
          execute: async () => ({ output: "ok" }),
        },
      ],
    };

    const result = await buildDefaultTools({ cwd: "/tmp", bundledToolProviders: [provider] });
    const names = result.tools.map((tool) => tool.name);

    expect(names).toContain("bundled_default_tool");
    expect(result.toolState.find((entry) => entry.name === "bundled_default_tool")).toMatchObject({
      source: "plugin",
      pluginPackage: "@product/default-tools",
      enabled: true,
      available: true,
    });
  });

  test("executes a hello-world bundled tool without plugin loading", async () => {
    const originalHome = process.env.HOME;
    const isolatedHome = await mkdtemp(join(tmpdir(), "diligent-defaults-home-"));
    process.env.HOME = isolatedHome;

    const provider: BundledToolProvider = {
      id: "@product/hello-world-tools",
      createTools: () => [
        {
          name: "hello_world",
          description: "Say hello from a bundled product tool",
          parameters: z.object({ name: z.string().optional() }),
          execute: async (args) => ({ output: `Hello, ${args.name ?? "world"}!` }),
        },
      ],
    };

    try {
      const result = await buildDefaultTools({ cwd: "/tmp", bundledToolProviders: [provider] });
      const tool = result.tools.find((candidate) => candidate.name === "hello_world");

      expect(tool).toBeDefined();
      expect(
        await tool!.execute({ name: "bundled tool" }, { toolCallId: "test", signal: new AbortController().signal }),
      ).toEqual({
        output: "Hello, bundled tool!",
      });
      expect(result.pluginState).toEqual([]);
      expect(result.pluginErrors).toEqual([]);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(isolatedHome, { recursive: true, force: true });
    }
  });
});
