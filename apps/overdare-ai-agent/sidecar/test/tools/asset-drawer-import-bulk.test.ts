// @summary Tests studiorpc_asset_drawer_import_bulk: single approval, sequential RPC
// loop, per-item failure isolation, and the assetid→guids map output.

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@diligent/core/tool-contract";
import { createStudioRpcToolProvider } from "../../src/tools/studiorpc";

function makeStudioProject(): string {
  const cwd = join(tmpdir(), `sidecar-bulk-import-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "Test.umap"), "");
  writeFileSync(
    join(cwd, "Test.ovdrjm"),
    JSON.stringify({ Root: { InstanceType: "Workspace", ActorGuid: "ws", Name: "Workspace", LuaChildren: [] } }),
  );
  return cwd;
}

interface RpcCall {
  method: string;
  params?: Record<string, unknown>;
}

async function loadBulkTool(opts: {
  rpcCalls: RpcCall[];
  failFor?: string;
  approvals?: Array<{ description?: string }>;
  approveResult?: "once" | "reject";
}): Promise<{ tool: Tool; cleanup: () => void }> {
  const cwd = makeStudioProject();
  const provider = createStudioRpcToolProvider({
    callRpc: async (method, params) => {
      opts.rpcCalls.push({ method, params });
      if (method === "asset_drawer.import" && params?.assetid === opts.failFor) {
        throw new Error("Studio RPC error [-32000]: import failed");
      }
      if (method === "asset_drawer.import") {
        return { success: true, guids: [`guid-${params?.assetid}`] };
      }
      return { ok: true };
    },
  });
  const tools = await provider.createTools({
    cwd,
    host: {
      approve: async (request: { description?: string }) => {
        opts.approvals?.push(request);
        return opts.approveResult ?? "once";
      },
    },
  });
  const tool = tools.find((t) => t.name === "studiorpc_asset_drawer_import_bulk");
  if (!tool) throw new Error("studiorpc_asset_drawer_import_bulk not registered");
  return { tool, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

const ctx = { toolCallId: "t", signal: new AbortController().signal, abort: () => {} };

const threeAssets = [
  { assetid: "ovdrassetid://1", assetName: "Car 01" },
  { assetid: "ovdrassetid://2", assetName: "Railroad 01" },
  { assetid: "ovdrassetid://3", assetName: "Pillar 01" },
];

describe("studiorpc_asset_drawer_import_bulk", () => {
  test("one approval for the whole batch, mentioning the count", async () => {
    const rpcCalls: RpcCall[] = [];
    const approvals: Array<{ description?: string }> = [];
    const { tool, cleanup } = await loadBulkTool({ rpcCalls, approvals });
    try {
      await tool.execute({ assets: threeAssets }, ctx);
      expect(approvals.length).toBe(1);
      expect(approvals[0].description).toContain("3");
    } finally {
      cleanup();
    }
  });

  test("imports sequentially with assetType MODEL and saves once at the end", async () => {
    const rpcCalls: RpcCall[] = [];
    const { tool, cleanup } = await loadBulkTool({ rpcCalls });
    try {
      await tool.execute({ assets: threeAssets }, ctx);
      const imports = rpcCalls.filter((c) => c.method === "asset_drawer.import");
      expect(imports.map((c) => c.params?.assetid)).toEqual(["ovdrassetid://1", "ovdrassetid://2", "ovdrassetid://3"]);
      expect(imports.every((c) => c.params?.assetType === "MODEL")).toBe(true);
      expect(rpcCalls.filter((c) => c.method === "level.save.file").length).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("output maps every assetid to its returned guids", async () => {
    const rpcCalls: RpcCall[] = [];
    const { tool, cleanup } = await loadBulkTool({ rpcCalls });
    try {
      const result = await tool.execute({ assets: threeAssets }, ctx);
      const parsed = JSON.parse(result.output.replace(/^[\s\S]*?(?=\{)/, ""));
      expect(parsed.imported.length).toBe(3);
      expect(parsed.imported[0]).toEqual({
        assetid: "ovdrassetid://1",
        assetName: "Car 01",
        guids: ["guid-ovdrassetid://1"],
      });
      expect(parsed.failed).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("a mid-batch failure is isolated and later imports still run", async () => {
    const rpcCalls: RpcCall[] = [];
    const { tool, cleanup } = await loadBulkTool({ rpcCalls, failFor: "ovdrassetid://2" });
    try {
      const result = await tool.execute({ assets: threeAssets }, ctx);
      const parsed = JSON.parse(result.output.replace(/^[\s\S]*?(?=\{)/, ""));
      expect(parsed.imported.map((i: { assetid: string }) => i.assetid)).toEqual([
        "ovdrassetid://1",
        "ovdrassetid://3",
      ]);
      expect(parsed.failed.length).toBe(1);
      expect(parsed.failed[0].assetid).toBe("ovdrassetid://2");
      expect(parsed.failed[0].error).toContain("import failed");
    } finally {
      cleanup();
    }
  });

  test("rejection imports nothing", async () => {
    const rpcCalls: RpcCall[] = [];
    const { tool, cleanup } = await loadBulkTool({ rpcCalls, approveResult: "reject" });
    try {
      const result = await tool.execute({ assets: threeAssets }, ctx);
      expect(result.output).toContain("[Rejected by user]");
      expect(rpcCalls.filter((c) => c.method === "asset_drawer.import").length).toBe(0);
    } finally {
      cleanup();
    }
  });
});
