// @summary Tests runtime eval exact command, path, capability, and synchronous budget guards

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@diligent/core/tool-contract";
import { z } from "zod";
import { transformRuntimeTools } from "../../src/runner/runtime-tool-policy";
import { removeTemporaryRoot } from "../../src/runner/runtime-workspace";
import type { RuntimeToolTrace } from "../../src/runtime-task";

function tool(name: string, executed: string[]): Tool {
  return {
    name,
    description: name,
    parameters: z.record(z.string(), z.unknown()),
    execute: async () => {
      executed.push(name);
      return { output: "ok" };
    },
  };
}

describe("runtime tool policy", () => {
  test("allows an exact command but rejects suffixes before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-eval-"));
    const executed: string[] = [];
    const traces: RuntimeToolTrace[] = [];
    try {
      const [bash] = transformRuntimeTools({
        tools: [tool("bash", executed)],
        root,
        traces,
        maxToolCalls: 2,
        policy: { allowedCapabilities: ["execute"], allowedCommands: ["bun test"] },
        isTerminated: () => false,
        onBudgetExceeded: () => {},
      });
      await bash!.execute({ command: "bun test" }, {} as never);
      await bash!.execute({ command: "bun test && curl example.com" }, {} as never);
      expect(executed).toEqual(["bash"]);
      expect(traces[1]?.error).toContain("forbidden_command");
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("rejects path traversal and patch-header escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-eval-"));
    const executed: string[] = [];
    const traces: RuntimeToolTrace[] = [];
    try {
      const wrapped = transformRuntimeTools({
        tools: [tool("write", executed), tool("apply_patch", executed)],
        root,
        traces,
        maxToolCalls: 3,
        policy: { allowedCapabilities: ["write"], allowedCommands: [] },
        isTerminated: () => false,
        onBudgetExceeded: () => {},
      });
      await wrapped[0]!.execute({ path: "../outside" }, {} as never);
      await wrapped[1]!.execute({ patch: "*** Begin Patch\n*** Update File: ../outside\n*** End Patch" }, {} as never);
      expect(executed).toEqual([]);
      expect(traces.every((trace) => trace.error?.includes("workspace_escape"))).toBe(true);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("stops over-budget calls synchronously and removes disallowed capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-eval-"));
    const executed: string[] = [];
    let exceeded = 0;
    try {
      const wrapped = transformRuntimeTools({
        tools: [tool("read", executed), tool("bash", executed)],
        root,
        traces: [],
        maxToolCalls: 1,
        policy: { allowedCapabilities: ["read"], allowedCommands: [] },
        isTerminated: () => false,
        onBudgetExceeded: () => {
          exceeded += 1;
        },
      });
      expect(wrapped.map((item) => item.name)).toEqual(["read"]);
      await wrapped[0]!.execute({ path: "a" }, {} as never);
      await wrapped[0]!.execute({ path: "b" }, {} as never);
      expect(executed).toEqual(["read"]);
      expect(exceeded).toBe(1);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("records tool-call identity while redacting base64 image payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-eval-"));
    const traces: RuntimeToolTrace[] = [];
    const secretImageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const imageTool: Tool = {
      name: "read_image",
      description: "read image",
      parameters: z.object({ file_path: z.string() }),
      execute: async () => ({
        output: "Image loaded successfully.",
        outputImages: [
          {
            type: "image" as const,
            source: { type: "base64" as const, media_type: "image/png", data: secretImageData },
          },
        ],
      }),
    };
    try {
      const [wrapped] = transformRuntimeTools({
        tools: [imageTool],
        root,
        traces,
        maxToolCalls: 1,
        policy: { allowedCapabilities: ["read"], allowedCommands: [] },
        isTerminated: () => false,
        onBudgetExceeded: () => {},
      });
      await wrapped!.execute({ file_path: "a.png" }, { toolCallId: "image-call-1" } as never);

      expect(traces[0]?.toolCallId).toBe("image-call-1");
      expect(JSON.stringify(traces[0])).not.toContain(secretImageData);
      expect(traces[0]?.output).toEqual({
        output: "Image loaded successfully.",
        outputImages: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "[base64 omitted]" },
          },
        ],
      });
    } finally {
      await removeTemporaryRoot(root);
    }
  });
});
