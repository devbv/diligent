// @summary Tests for the MCP bundled provider — enable filtering, per-tool toggles, namespacing

import { afterEach, describe, expect, test } from "bun:test";
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
import { createMcpToolProvider, filterEnabledServers } from "../../../src/tools/mcp/provider";
import type { McpServerConfig } from "../../../src/tools/mcp/types";

function serverWithTools(name: string): McpServer {
  const server = new McpServer({ name, version: "1.0.0" });
  for (const toolName of ["alpha", "beta"]) {
    server.registerTool(toolName, { description: toolName, inputSchema: { x: z.string() } }, async () => ({
      content: [{ type: "text", text: toolName }],
    }));
  }
  return server;
}

const factory: McpTransportFactory = async (name): Promise<Transport> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await serverWithTools(name).connect(serverTransport);
  return clientTransport;
};

afterEach(() => __resetMcpManagerForTest());

describe("filterEnabledServers", () => {
  test("drops servers with enabled:false", () => {
    const servers: Record<string, McpServerConfig> = {
      on: { command: "x" },
      off: { command: "x", enabled: false },
    };
    expect(Object.keys(filterEnabledServers(servers))).toEqual(["on"]);
  });
});

describe("createMcpToolProvider", () => {
  test("exposes namespaced tools for connected servers", async () => {
    __setMcpManagerForTest(new McpConnectionManager(factory));
    const provider = createMcpToolProvider({ docs: { command: "x" } });
    const tools = await provider.createTools({ cwd: process.cwd() });
    expect(tools.map((t) => t.name).sort()).toEqual(["mcp__docs__alpha", "mcp__docs__beta"]);
  });

  test("per-tool toggle removes only the disabled tool", async () => {
    __setMcpManagerForTest(new McpConnectionManager(factory));
    const provider = createMcpToolProvider({ docs: { command: "x", tools: { beta: false } } });
    const tools = await provider.createTools({ cwd: process.cwd() });
    expect(tools.map((t) => t.name)).toEqual(["mcp__docs__alpha"]);
  });

  test("disabled server yields no tools", async () => {
    __setMcpManagerForTest(new McpConnectionManager(factory));
    const provider = createMcpToolProvider({ docs: { command: "x", enabled: false } });
    const tools = await provider.createTools({ cwd: process.cwd() });
    expect(tools).toHaveLength(0);
  });
});
