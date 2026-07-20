// @summary Tests runtime eval exact command, path, capability, and synchronous budget guards

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@diligent/core/tool-contract";
import { z } from "zod";
import { normalizeEvidencePath, transformRuntimeTools } from "../../src/runner/runtime-tool-policy";
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

const DEFAULT_LIMITS = {
  maxToolCalls: 10,
  maxUserInputRequests: 10,
  maxChildAgents: 10,
};

describe("runtime tool policy", () => {
  test("normalizes aliased Windows evidence paths to provider-neutral separators", () => {
    expect(normalizeEvidencePath("$WORKSPACE\\references\\initial.fact")).toBe("$WORKSPACE/references/initial.fact");
    expect(normalizeEvidencePath("$TOOL_OUTPUT\\full\\result.txt")).toBe("$TOOL_OUTPUT/full/result.txt");
    expect(normalizeEvidencePath("Error opening '$WORKSPACE\\records\\active.json'")).toBe(
      "Error opening '$WORKSPACE/records/active.json'",
    );
    expect(normalizeEvidencePath("literal\\content")).toBe("literal\\content");
  });

  test("allows an exact command but rejects suffixes before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-eval-"));
    const executed: string[] = [];
    const traces: RuntimeToolTrace[] = [];
    try {
      const [bash] = transformRuntimeTools({
        tools: [tool("bash", executed)],
        root,
        traces,
        ...DEFAULT_LIMITS,
        policy: { allowedCapabilities: ["execute"], allowedCommands: ["bun test"] },
        isTerminated: () => false,
        onBudgetExceeded: () => {},
      });
      expect(bash?.description).toBe(
        'bash\n\nRuntime eval command contract: only these exact command strings are permitted: "bun test".',
      );
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
        ...DEFAULT_LIMITS,
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
        ...DEFAULT_LIMITS,
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
        ...DEFAULT_LIMITS,
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
      expect(traces[0]?.outcome).toBe("success");
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test.each([
    { name: "request_user_input", limitKey: "maxUserInputRequests" as const },
    { name: "spawn_agent", limitKey: "maxChildAgents" as const },
  ])("allows the first $name operation and rejects the next before execution", async ({ name, limitKey }) => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-eval-"));
    const executed: string[] = [];
    const traces: RuntimeToolTrace[] = [];
    const budgetReasons: string[] = [];
    try {
      const [wrapped] = transformRuntimeTools({
        tools: [tool(name, executed)],
        root,
        traces,
        ...DEFAULT_LIMITS,
        [limitKey]: 1,
        policy: {
          allowedCapabilities: [name === "request_user_input" ? "user_input" : "collab"],
          allowedCommands: [],
        },
        isTerminated: () => false,
        onBudgetExceeded: (reason) => budgetReasons.push(reason),
      });

      const allowed = await wrapped!.execute({}, { toolCallId: `${name}-1` } as never);
      const rejected = await wrapped!.execute({}, { toolCallId: `${name}-2` } as never);

      expect(allowed).toEqual({ output: "ok" });
      expect(executed).toEqual([name]);
      expect(rejected.metadata).toMatchObject({ error: true, runtimeEvalRejected: true });
      expect(traces.map((trace) => trace.outcome)).toEqual(["success", "policy_rejection"]);
      expect(traces[1]?.error).toContain(name === "request_user_input" ? "user_input_requests" : "child_agents");
      expect(budgetReasons).toEqual([name === "request_user_input" ? "user_input_limit" : "child_agent_limit"]);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("distinguishes thrown and metadata tool errors from harness policy rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-eval-"));
    const traces: RuntimeToolTrace[] = [];
    const thrown = tool("read", []);
    thrown.execute = async () => {
      throw new Error(`failed under ${root}`);
    };
    const metadataError = tool("grep", []);
    metadataError.execute = async () => ({ output: `missing ${root}/fixture.txt`, metadata: { error: true } });
    try {
      const wrapped = transformRuntimeTools({
        tools: [thrown, metadataError],
        root,
        traces,
        ...DEFAULT_LIMITS,
        policy: { allowedCapabilities: ["read"], allowedCommands: [] },
        isTerminated: () => false,
        onBudgetExceeded: () => {},
      });

      const thrownResult = await wrapped[0]!.execute({}, { toolCallId: "throw-1" } as never);
      const metadataResult = await wrapped[1]!.execute({}, { toolCallId: "metadata-1" } as never);

      expect(thrownResult.metadata).toEqual({ error: true });
      expect(thrownResult.metadata).not.toHaveProperty("runtimeEvalRejected");
      expect(metadataResult.metadata).toEqual({ error: true });
      expect(traces.map((trace) => trace.outcome)).toEqual(["runtime_error", "runtime_error"]);
      expect(JSON.stringify(traces)).not.toContain(root);
      expect(traces[0]?.error).toContain("$WORKSPACE");
      expect(traces[1]?.output).toMatchObject({ output: "missing $WORKSPACE/fixture.txt" });
    } finally {
      await removeTemporaryRoot(root);
    }
  });
});
