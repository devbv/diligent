// @summary Tests for the MCP tool -> Diligent Tool bridge (schema passthrough, approval, result map)

import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@diligent/core/tool/types";
import type { McpConnectionManager } from "@diligent/runtime/tools";
import {
  mapMcpCallResult,
  mcpToolName,
  mcpToolToDiligentTool,
  resolveMcpOutputLimit,
} from "../../../src/tools/mcp/to-tool";
import type { McpCallResult, McpOutputLimit, McpToolDef } from "../../../src/tools/mcp/types";

function makeCtx(): ToolContext {
  return { toolCallId: "tc_mcp", signal: new AbortController().signal, abort: () => {} };
}

function fakeManager(
  result: McpCallResult | (() => Promise<McpCallResult>),
  onCall?: () => void,
): McpConnectionManager {
  return {
    async call(): Promise<McpCallResult> {
      onCall?.();
      return typeof result === "function" ? result() : result;
    },
  } as unknown as McpConnectionManager;
}

const def: McpToolDef = {
  name: "search_issues",
  description: "Search issues",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
};

describe("mcpToolName", () => {
  test("namespaces and sanitizes", () => {
    expect(mcpToolName("git hub", "search/issues")).toBe("mcp__git_hub__search_issues");
  });

  test("caps at 64 bytes with stable hash suffix on overflow", () => {
    const name = mcpToolName("server", "x".repeat(80));
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(64);
    expect(mcpToolName("server", "x".repeat(80))).toBe(name); // stable
  });
});

describe("mcpToolToDiligentTool", () => {
  test("advertises MCP inputSchema verbatim", () => {
    const tool = mcpToolToDiligentTool({
      serverName: "github",
      def,
      manager: fakeManager({ text: "", images: [], isError: false }),
    });
    expect(tool.inputSchema).toBe(def.inputSchema);
    expect(tool.name).toBe("mcp__github__search_issues");
  });

  test("readOnly tools are parallel-safe", () => {
    const tool = mcpToolToDiligentTool({
      serverName: "g",
      def: { ...def, readOnly: true },
      manager: fakeManager({ text: "", images: [], isError: false }),
    });
    expect(tool.supportParallel).toBe(true);
  });

  test("reject short-circuits without calling the manager", async () => {
    let called = false;
    const tool = mcpToolToDiligentTool({
      serverName: "github",
      def,
      manager: fakeManager({ text: "x", images: [], isError: false }, () => {
        called = true;
      }),
      host: { approve: async () => "reject" },
    });
    const result = await tool.execute({ q: "open" }, makeCtx());
    expect(called).toBe(false);
    expect(result.output).toMatch(/rejected/i);
  });

  test("maps text and image content", async () => {
    const tool = mcpToolToDiligentTool({
      serverName: "github",
      def,
      manager: fakeManager({
        text: "Found 3 issues",
        images: [{ data: "AAAA", mimeType: "image/png" }],
        isError: false,
      }),
      host: { approve: async () => "once" },
    });
    const result = await tool.execute({ q: "open" }, makeCtx());
    expect(result.output).toBe("Found 3 issues");
    expect(result.outputImages).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
    expect(result.metadata).toMatchObject({ mcpServer: "github", mcpTool: "search_issues", isError: false });
  });

  test("drops unsupported image media types", async () => {
    const tool = mcpToolToDiligentTool({
      serverName: "github",
      def,
      manager: fakeManager({ text: "ok", images: [{ data: "AAAA", mimeType: "image/tiff" }], isError: false }),
      host: { approve: async () => "once" },
    });
    const result = await tool.execute({ q: "open" }, makeCtx());
    expect(result.outputImages).toBeUndefined();
  });

  test("surfaces error results with a fallback message", async () => {
    const tool = mcpToolToDiligentTool({
      serverName: "github",
      def,
      manager: fakeManager({ text: "", images: [], isError: true }),
      host: { approve: async () => "once" },
    });
    const result = await tool.execute({ q: "open" }, makeCtx());
    expect(result.output).toMatch(/error/i);
    expect(result.metadata).toMatchObject({ isError: true });
  });

  test("applies the output limit as a per-result byte cap", () => {
    const limit: McpOutputLimit = { maxBytes: 4000, warnBytes: 2000 };
    const mapped = mapMcpCallResult({ text: "body", images: [], isError: false }, "s", "t", limit);
    expect(mapped.maxOutputBytes).toBe(4000);
  });

  test("no output limit leaves maxOutputBytes unset (default cap applies)", () => {
    const mapped = mapMcpCallResult({ text: "body", images: [], isError: false }, "s", "t");
    expect(mapped.maxOutputBytes).toBeUndefined();
  });
});

describe("resolveMcpOutputLimit", () => {
  const base: McpOutputLimit = { maxBytes: 100_000, warnBytes: 40_000 };

  test("per-tool char override replaces maxBytes but keeps warn", () => {
    expect(resolveMcpOutputLimit(25_000, base)).toEqual({ maxBytes: 25_000, warnBytes: 40_000 });
  });

  test("no override returns the default limit unchanged", () => {
    expect(resolveMcpOutputLimit(undefined, base)).toBe(base);
  });
});
