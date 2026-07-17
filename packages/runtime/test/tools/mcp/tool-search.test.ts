// @summary Tests for lazy MCP tools — search filtering/index/limit and run proxy validation

import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@diligent/core/tool-contract";
import type { McpConnectionManager } from "../../../src/tools/mcp/client";
import { createMcpRunTool, createMcpSearchTool } from "../../../src/tools/mcp/tool-search";
import type { McpCallResult, McpCatalogEntry, McpOutputLimit } from "../../../src/tools/mcp/types";

const limit: McpOutputLimit = { maxBytes: 1000, warnBytes: 500 };

const catalog: McpCatalogEntry[] = [
  {
    server: "docs",
    tool: "search_docs",
    description: "Search the documentation",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  },
  {
    server: "docs",
    tool: "create_page",
    description: "Create a documentation page",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
  {
    server: "jira",
    tool: "get_issue",
    description: "Fetch a Jira issue by key",
    inputSchema: { type: "object", properties: { key: { type: "string" } } },
  },
];

const ctx = { signal: new AbortController().signal } as ToolContext;

function fakeManager(onCall: (server: string, tool: string, args: unknown) => McpCallResult): McpConnectionManager {
  return {
    async call(server: string, tool: string, args: unknown): Promise<McpCallResult> {
      return onCall(server, tool, args);
    },
  } as unknown as McpConnectionManager;
}

describe("createMcpSearchTool", () => {
  test("description carries a compact server→tool index", () => {
    const tool = createMcpSearchTool(catalog);
    expect(tool.name).toBe("mcp_search_tools");
    expect(tool.description).toContain("Available MCP tools by server:");
    expect(tool.description).toContain("docs (2): search_docs, create_page");
    expect(tool.description).toContain("jira (1): get_issue");
  });

  test("no args lists all tools with their input schemas", async () => {
    const result = await createMcpSearchTool(catalog).execute({}, ctx);
    const parsed = JSON.parse(result.output) as { server: string; tool: string; inputSchema: unknown }[];
    expect(parsed.map((e) => e.tool).sort()).toEqual(["create_page", "get_issue", "search_docs"]);
    expect(parsed.find((e) => e.tool === "get_issue")?.inputSchema).toEqual({
      type: "object",
      properties: { key: { type: "string" } },
    });
  });

  test("query keyword-filters across name and description", async () => {
    const result = await createMcpSearchTool(catalog).execute({ query: "jira issue" }, ctx);
    const parsed = JSON.parse(result.output) as { tool: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.tool).toBe("get_issue");
  });

  test("server scopes results to one server", async () => {
    const result = await createMcpSearchTool(catalog).execute({ server: "docs" }, ctx);
    const parsed = JSON.parse(result.output) as { server: string }[];
    expect(parsed.every((e) => e.server === "docs")).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  test("no match returns a helpful message, not JSON", async () => {
    const result = await createMcpSearchTool(catalog).execute({ query: "zzznope" }, ctx);
    expect(result.output).toContain("No MCP tools matched");
  });

  test("caps results and notes truncation", async () => {
    const big: McpCatalogEntry[] = Array.from({ length: 30 }, (_, i) => ({
      server: "big",
      tool: `tool_${i}`,
      description: "x",
      inputSchema: { type: "object" },
    }));
    const result = await createMcpSearchTool(big).execute({}, ctx);
    expect(result.output).toContain("Showing 25 of 30 matches");
  });
});

describe("createMcpRunTool", () => {
  test("proxies a valid call through the manager", async () => {
    let seen: { server: string; tool: string; args: unknown } | undefined;
    const manager = fakeManager((server, tool, args) => {
      seen = { server, tool, args };
      return { text: "issue body", images: [], isError: false };
    });
    const tool = createMcpRunTool({ catalog, manager, outputLimit: limit });
    const result = await tool.execute({ server: "jira", tool: "get_issue", args: { key: "ABC-1" } }, ctx);
    expect(seen).toEqual({ server: "jira", tool: "get_issue", args: { key: "ABC-1" } });
    expect(result.output).toBe("issue body");
    expect(result.metadata).toMatchObject({ mcpServer: "jira", mcpTool: "get_issue", isError: false });
    expect(result.maxOutputBytes).toBe(1000);
  });

  test("per-tool maxResultSizeChars overrides the default cap", async () => {
    const withOverride: McpCatalogEntry[] = [
      { server: "docs", tool: "big_tool", inputSchema: { type: "object" }, maxResultSizeChars: 50_000 },
    ];
    const manager = fakeManager(() => ({ text: "ok", images: [], isError: false }));
    const tool = createMcpRunTool({ catalog: withOverride, manager, outputLimit: limit });
    const result = await tool.execute({ server: "docs", tool: "big_tool", args: {} }, ctx);
    expect(result.maxOutputBytes).toBe(50_000);
  });

  test("rejects unknown server/tool without calling the manager", async () => {
    let called = false;
    const manager = fakeManager(() => {
      called = true;
      return { text: "", images: [], isError: false };
    });
    const tool = createMcpRunTool({ catalog, manager, outputLimit: limit });
    const result = await tool.execute({ server: "jira", tool: "nope", args: {} }, ctx);
    expect(called).toBe(false);
    expect(result.metadata).toMatchObject({ error: true });
    expect(result.output).toContain('Unknown MCP tool "nope"');
  });
});
