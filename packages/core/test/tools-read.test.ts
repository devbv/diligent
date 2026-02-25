import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../src/tool/types";
import { createReadTool } from "../src/tools/read";

function makeCtx(): ToolContext {
  return {
    toolCallId: "tc_test",
    signal: new AbortController().signal,
    approve: async () => "once" as const,
  };
}

describe("read tool", () => {
  let tmpDir: string;
  const tool = createReadTool();

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "read-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("reads file with line numbers", async () => {
    const filePath = join(tmpDir, "test.txt");
    await writeFile(filePath, "line one\nline two\nline three\n");

    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.output).toContain("1\tline one");
    expect(result.output).toContain("2\tline two");
    expect(result.output).toContain("3\tline three");
    expect(result.truncateDirection).toBe("head");
  });

  test("reads with offset and limit", async () => {
    const filePath = join(tmpDir, "test.txt");
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    await writeFile(filePath, lines);

    const result = await tool.execute({ file_path: filePath, offset: 10, limit: 5 }, makeCtx());
    expect(result.output).toContain("10\tline 10");
    expect(result.output).toContain("14\tline 14");
    expect(result.output).not.toContain("line 15");
  });

  test("default limit is 2000 lines", async () => {
    const filePath = join(tmpDir, "big.txt");
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
    await writeFile(filePath, lines);

    const result = await tool.execute({ file_path: filePath }, makeCtx());
    // Should show truncation note
    expect(result.output).toContain("showing lines");
    expect(result.output).toContain("of 3000 total");
  });

  test("returns error for missing file", async () => {
    const result = await tool.execute({ file_path: join(tmpDir, "nonexistent.txt") }, makeCtx());
    expect(result.output).toContain("Error: File not found");
    expect(result.metadata?.error).toBe(true);
  });

  test("detects binary file by extension", async () => {
    const filePath = join(tmpDir, "image.png");
    await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.output).toContain("Binary file");
    expect(result.output).toContain("bytes");
  });

  test("detects binary file by content", async () => {
    const filePath = join(tmpDir, "mystery.dat");
    // Create a file with >30% null bytes
    const buf = Buffer.alloc(100);
    buf.fill(0, 0, 50); // 50 null bytes
    buf.fill(0x41, 50); // 50 'A' bytes
    await writeFile(filePath, buf);

    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.output).toContain("Binary file");
  });

  test("reads empty file", async () => {
    const filePath = join(tmpDir, "empty.txt");
    await writeFile(filePath, "");

    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.output).toContain("1\t");
  });
});
