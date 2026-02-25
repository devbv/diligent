import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../src/tool/types";
import { bashTool } from "../src/tools/bash";

function makeCtx(signal?: AbortSignal): ToolContext {
  return {
    toolCallId: "tc_bash",
    signal: signal ?? new AbortController().signal,
    approve: async () => true,
  };
}

describe("bash tool", () => {
  test("simple command (echo hello)", async () => {
    const result = await bashTool.execute({ command: "echo hello" }, makeCtx());
    expect(result.output.trim()).toBe("hello");
  });

  test("non-zero exit code → exit code in header", async () => {
    const result = await bashTool.execute({ command: "exit 42" }, makeCtx());
    expect(result.output).toContain("[Exit code: 42]");
    expect(result.metadata?.exitCode).toBe(42);
  });

  test("timeout → kills process, timeout message", async () => {
    const result = await bashTool.execute({ command: "sleep 10", timeout: 200 }, makeCtx());
    expect(result.output).toContain("Timed out");
    expect(result.metadata?.timedOut).toBe(true);
  }, 5000);

  test("AbortSignal → kills process, aborted message", async () => {
    const ac = new AbortController();
    const promise = bashTool.execute({ command: "sleep 10" }, makeCtx(ac.signal));
    setTimeout(() => ac.abort(), 100);
    const result = await promise;
    expect(result.output).toContain("Aborted");
    expect(result.metadata?.aborted).toBe(true);
  }, 5000);

  test("stderr output → merged with [stderr] prefix", async () => {
    const result = await bashTool.execute({ command: "echo err >&2" }, makeCtx());
    expect(result.output).toContain("[stderr]");
    expect(result.output).toContain("err");
  });

  test("large output → truncated", async () => {
    // Generate output larger than 50KB
    const result = await bashTool.execute({ command: "python3 -c \"print('x' * 60000)\"" }, makeCtx());
    expect(result.metadata?.truncated).toBe(true);
  });

  test("description in metadata", async () => {
    const result = await bashTool.execute({ command: "echo hi", description: "test desc" }, makeCtx());
    expect(result.metadata?.description).toBe("test desc");
  });
});
