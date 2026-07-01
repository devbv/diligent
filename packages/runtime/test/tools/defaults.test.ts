// @summary Tests default tool assembly gating for provider-native web tools
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { BundledToolProvider } from "../../src/tools/bundled-provider";
import { buildDefaultTools } from "../../src/tools/defaults";
import {
  __resetMcpManagerForTest,
  __setMcpManagerForTest,
  McpConnectionManager,
  type McpTransportFactory,
} from "../../src/tools/mcp/client";

function toolNamesFor(result: Awaited<ReturnType<typeof buildDefaultTools>>): string[] {
  return result.tools.map((tool) => tool.name);
}

function stateNamesFor(result: Awaited<ReturnType<typeof buildDefaultTools>>): string[] {
  return result.toolState.map((tool) => tool.name);
}

describe("buildDefaultTools MCP OAuth wiring", () => {
  afterEach(() => {
    __resetMcpManagerForTest();
  });

  // Regression: HTTP OAuth MCP servers connected tokenless (invalid_token) at startup because the
  // tool build could run before the app-server wired OAuth deps. buildDefaultTools must guarantee
  // the deps are set on the very manager it syncs.
  test("wires OAuth deps on the manager before syncing MCP servers", async () => {
    const factory: McpTransportFactory = async (name): Promise<Transport> => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await new McpServer({ name, version: "1.0.0" }).connect(serverTransport);
      return clientTransport;
    };
    const manager = new McpConnectionManager(factory);
    __setMcpManagerForTest(manager);
    expect(manager.hasOAuthDeps()).toBe(false);

    await buildDefaultTools({ cwd: "/tmp", mcpServers: { atlassian: { url: "https://example.test/mcp" } } });

    expect(manager.hasOAuthDeps()).toBe(true);
  });
});

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

describe("buildDefaultTools provider-specific edit tools", () => {
  test("shows all edit tool families when provider is not fixed", async () => {
    const result = await buildDefaultTools({ cwd: "/tmp" });
    const names = toolNamesFor(result);
    const stateNames = stateNamesFor(result);

    expect(names).toContain("apply_patch");
    expect(names).toContain("edit");
    expect(names).toContain("multi_edit");
    expect(stateNames).toContain("apply_patch");
    expect(stateNames).toContain("edit");
    expect(stateNames).toContain("multi_edit");
  });

  test.each(["openai", "chatgpt"] as const)("uses apply_patch only for %s", async (provider) => {
    const result = await buildDefaultTools({ cwd: "/tmp", provider });
    const names = toolNamesFor(result);
    const stateNames = stateNamesFor(result);

    expect(names).toContain("apply_patch");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("multi_edit");
    expect(stateNames).toContain("apply_patch");
    expect(stateNames).not.toContain("edit");
    expect(stateNames).not.toContain("multi_edit");
  });

  test.each([
    "anthropic",
    "gemini",
    "vertex",
    "zai-coding-plan",
  ] as const)("uses edit and multi_edit only for %s", async (provider) => {
    const result = await buildDefaultTools({ cwd: "/tmp", provider });
    const names = toolNamesFor(result);
    const stateNames = stateNamesFor(result);

    expect(names).not.toContain("apply_patch");
    expect(names).toContain("edit");
    expect(names).toContain("multi_edit");
    expect(stateNames).not.toContain("apply_patch");
    expect(stateNames).toContain("edit");
    expect(stateNames).toContain("multi_edit");
  });

  test("cannot enable the opposite edit tool family through builtin config when provider is fixed", async () => {
    const openAiResult = await buildDefaultTools({
      cwd: "/tmp",
      provider: "openai",
      toolsConfig: { builtin: { edit: true, multi_edit: true } },
    });
    const anthropicResult = await buildDefaultTools({
      cwd: "/tmp",
      provider: "anthropic",
      toolsConfig: { builtin: { apply_patch: true } },
    });

    expect(toolNamesFor(openAiResult)).toContain("apply_patch");
    expect(toolNamesFor(openAiResult)).not.toContain("edit");
    expect(toolNamesFor(openAiResult)).not.toContain("multi_edit");
    expect(toolNamesFor(anthropicResult)).not.toContain("apply_patch");
    expect(toolNamesFor(anthropicResult)).toContain("edit");
    expect(toolNamesFor(anthropicResult)).toContain("multi_edit");
  });
});
