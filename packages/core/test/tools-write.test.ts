import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../src/tool/types";
import { createWriteTool } from "../src/tools/write";

function makeCtx(): ToolContext {
  return {
    toolCallId: "tc_test",
    signal: new AbortController().signal,
    approve: async () => true,
  };
}

describe("write tool", () => {
  let tmpDir: string;
  const tool = createWriteTool();

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("creates a new file", async () => {
    const filePath = join(tmpDir, "new.txt");
    const result = await tool.execute({ file_path: filePath, content: "hello world" }, makeCtx());

    expect(result.output).toContain("Wrote");
    expect(result.output).toContain("11 bytes");
    expect(result.output).toContain(filePath);

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("hello world");
  });

  test("overwrites existing file", async () => {
    const filePath = join(tmpDir, "existing.txt");
    await Bun.write(filePath, "old content");

    const result = await tool.execute({ file_path: filePath, content: "new content" }, makeCtx());
    expect(result.output).toContain("Wrote");

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("new content");
  });

  test("creates parent directories", async () => {
    const filePath = join(tmpDir, "deep", "nested", "dir", "file.txt");
    const result = await tool.execute({ file_path: filePath, content: "nested content" }, makeCtx());

    expect(result.output).toContain("Wrote");

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("nested content");
  });

  test("writes empty content", async () => {
    const filePath = join(tmpDir, "empty.txt");
    const result = await tool.execute({ file_path: filePath, content: "" }, makeCtx());

    expect(result.output).toContain("Wrote 0 bytes");
  });
});
