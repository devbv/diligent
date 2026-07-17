// @summary Tests for write tool file creation and overwriting
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@diligent/core/tool-contract";
import { createWriteAbsoluteTool, createWriteTool } from "@diligent/runtime/tools";

function makeCtx(): ToolContext {
  return {
    toolCallId: "tc_test",
    signal: new AbortController().signal,
    abort: () => {},
  };
}

describe("write tool", () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createWriteTool>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-"));
    tool = createWriteTool(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("creates a new file", async () => {
    const result = await tool.execute({ file_path: "new.txt", content: "hello world" }, makeCtx());

    const filePath = join(tmpDir, "new.txt");
    expect(result.output).toContain("Wrote");
    expect(result.output).toContain("11 bytes");
    expect(result.output).toContain("new.txt");
    expect(result.render).toBeDefined();
    expect(result.render?.outputSummary).toBe("1 file written");
    expect(result.render?.blocks[0]).toMatchObject({ type: "file" });

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("hello world");
  });

  test("overwrites existing file", async () => {
    const filePath = join(tmpDir, "existing.txt");
    await Bun.write(filePath, "old content");

    const result = await tool.execute({ file_path: "existing.txt", content: "new content" }, makeCtx());
    expect(result.output).toContain("Wrote");

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("new content");
  });

  test("creates parent directories", async () => {
    const filePath = join(tmpDir, "deep", "nested", "dir", "file.txt");
    const result = await tool.execute({ file_path: "deep/nested/dir/file.txt", content: "nested content" }, makeCtx());

    expect(result.output).toContain("Wrote");

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("nested content");
  });

  test("writes empty content", async () => {
    const result = await tool.execute({ file_path: "empty.txt", content: "" }, makeCtx());

    expect(result.output).toContain("Wrote 0 bytes");
  });

  test("returns error for absolute file_path", async () => {
    const result = await tool.execute({ file_path: join(tmpDir, "absolute.txt"), content: "hello" }, makeCtx());
    expect(result.output).toContain("file_path must be relative");
    expect(result.render?.blocks[0]).toMatchObject({ type: "text", title: "Output" });
    expect(result.metadata?.error).toBe(true);
  });
});

describe("write tool (absolute path variant)", () => {
  test("writes to an absolute path", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "write-absolute-test-"));
    const tool = createWriteAbsoluteTool();
    const filePath = join(tmpDir, "absolute.txt");

    try {
      const result = await tool.execute({ file_path: filePath, content: "absolute content" }, makeCtx());
      expect(result.output).toContain("Wrote");
      expect(result.render?.outputSummary).toBe("1 file written");

      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("absolute content");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns error for relative file_path", async () => {
    const tool = createWriteAbsoluteTool();
    const result = await tool.execute({ file_path: "relative.txt", content: "hello" }, makeCtx());
    expect(result.output).toContain("file_path must be absolute");
    expect(result.metadata?.error).toBe(true);
  });
});
