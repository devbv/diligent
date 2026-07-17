// @summary Tests for MCP resources/prompts — manager methods, proxy tools, capability gating

import { afterEach, describe, expect, test } from "bun:test";
import type { ToolContext } from "@diligent/core/tool-contract";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import {
  __resetMcpManagerForTest,
  __setMcpManagerForTest,
  McpConnectionManager,
  type McpTransportFactory,
} from "../../../src/tools/mcp/client";
import { createMcpToolProvider } from "../../../src/tools/mcp/provider";
import { createMcpPromptTools, createMcpResourceTools } from "../../../src/tools/mcp/resources-prompts";

/** Server exposing a tool + a resource + a prompt (so capabilities include all three). */
function richServer(name: string): McpServer {
  const server = new McpServer({ name, version: "1.0.0" });
  server.registerTool("alpha", { description: "alpha", inputSchema: { x: z.string() } }, async () => ({
    content: [{ type: "text", text: "alpha" }],
  }));
  server.registerResource("doc", "test://doc", { description: "A doc", mimeType: "text/plain" }, async (uri) => ({
    contents: [{ uri: uri.href, text: "hello world" }],
  }));
  server.registerPrompt("greet", { description: "Greeting", argsSchema: { who: z.string() } }, ({ who }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Hi ${who}` } }],
  }));
  return server;
}

/** Tools-only server (no resources/prompts capability). */
function toolsOnlyServer(name: string): McpServer {
  const server = new McpServer({ name, version: "1.0.0" });
  server.registerTool("alpha", { description: "alpha", inputSchema: { x: z.string() } }, async () => ({
    content: [{ type: "text", text: "alpha" }],
  }));
  return server;
}

function factoryFor(build: (name: string) => McpServer): McpTransportFactory {
  return async (name): Promise<Transport> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await build(name).connect(serverTransport);
    return clientTransport;
  };
}

const ctx = { toolCallId: "tc", signal: new AbortController().signal, abort: () => {} } as ToolContext;

afterEach(() => __resetMcpManagerForTest());

describe("McpConnectionManager resources/prompts", () => {
  test("detects capabilities and lists/reads resources", async () => {
    const manager = new McpConnectionManager(factoryFor(richServer));
    await manager.sync({ docs: { command: "x" } });
    expect(manager.supportsResources("docs")).toBe(true);
    expect(manager.supportsPrompts("docs")).toBe(true);

    const resources = await manager.listResources("docs");
    expect(resources).toEqual([{ uri: "test://doc", name: "doc", description: "A doc", mimeType: "text/plain" }]);

    const read = await manager.readResource("docs", "test://doc", ctx.signal);
    expect(read.text).toBe("hello world");
  });

  test("lists and renders prompts", async () => {
    const manager = new McpConnectionManager(factoryFor(richServer));
    await manager.sync({ docs: { command: "x" } });

    const prompts = await manager.listPrompts("docs");
    expect(prompts[0]).toMatchObject({ name: "greet", description: "Greeting" });

    const rendered = await manager.getPrompt("docs", "greet", { who: "Sam" }, ctx.signal);
    expect(rendered.text).toContain("user: Hi Sam");
  });

  test("tools-only server reports no resource/prompt capability", async () => {
    const manager = new McpConnectionManager(factoryFor(toolsOnlyServer));
    await manager.sync({ docs: { command: "x" } });
    expect(manager.supportsResources("docs")).toBe(false);
    expect(manager.supportsPrompts("docs")).toBe(false);
    expect(await manager.listResources("docs")).toEqual([]);
    expect(await manager.listPrompts("docs")).toEqual([]);
  });
});

describe("resource/prompt proxy tools", () => {
  test("mcp_read_resource proxies through the manager", async () => {
    const manager = new McpConnectionManager(factoryFor(richServer));
    await manager.sync({ docs: { command: "x" } });
    const [, readTool] = createMcpResourceTools(["docs"], manager);
    const result = await readTool.execute({ server: "docs", uri: "test://doc" }, ctx);
    expect(result.output).toBe("hello world");
    expect(result.metadata).toMatchObject({ mcpServer: "docs", mcpResource: "test://doc" });
  });

  test("mcp_get_prompt renders a prompt with arguments", async () => {
    const manager = new McpConnectionManager(factoryFor(richServer));
    await manager.sync({ docs: { command: "x" } });
    const [, getTool] = createMcpPromptTools(["docs"], manager);
    const result = await getTool.execute({ server: "docs", name: "greet", args: { who: "Sam" } }, ctx);
    expect(result.output).toContain("Hi Sam");
  });

  test("unknown server is rejected without calling the manager", async () => {
    const manager = new McpConnectionManager(factoryFor(richServer));
    await manager.sync({ docs: { command: "x" } });
    const [, readTool] = createMcpResourceTools(["docs"], manager);
    const result = await readTool.execute({ server: "nope", uri: "test://doc" }, ctx);
    expect(result.metadata).toMatchObject({ error: true });
  });
});

describe("provider capability gating", () => {
  test("exposes resource + prompt tools when a server supports them", async () => {
    __setMcpManagerForTest(new McpConnectionManager(factoryFor(richServer)));
    const provider = createMcpToolProvider({ docs: { command: "x" } });
    const tools = await provider.createTools({ cwd: process.cwd() });
    const names = tools.map((t) => t.name);
    expect(names).toContain("mcp_list_resources");
    expect(names).toContain("mcp_read_resource");
    expect(names).toContain("mcp_list_prompts");
    expect(names).toContain("mcp_get_prompt");
  });

  test("omits resource/prompt tools for a tools-only server", async () => {
    __setMcpManagerForTest(new McpConnectionManager(factoryFor(toolsOnlyServer)));
    const provider = createMcpToolProvider({ docs: { command: "x" } });
    const tools = await provider.createTools({ cwd: process.cwd() });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("mcp_list_resources");
    expect(names).not.toContain("mcp_list_prompts");
  });

  test("config toggles disable resource/prompt exposure", async () => {
    __setMcpManagerForTest(new McpConnectionManager(factoryFor(richServer)));
    const provider = createMcpToolProvider(
      { docs: { command: "x" } },
      { exposeResources: false, exposePrompts: false },
    );
    const tools = await provider.createTools({ cwd: process.cwd() });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("mcp_list_resources");
    expect(names).not.toContain("mcp_get_prompt");
  });
});
