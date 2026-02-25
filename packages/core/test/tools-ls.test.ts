import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../src/tool/types";
import { createLsTool } from "../src/tools/ls";

function makeCtx(): ToolContext {
  return {
    toolCallId: "tc_test",
    signal: new AbortController().signal,
    approve: async () => true,
  };
}

describe("ls tool", () => {
  let tmpDir: string;
  const tool = createLsTool();

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ls-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("lists files and directories", async () => {
    await writeFile(join(tmpDir, "file.txt"), "content");
    await mkdir(join(tmpDir, "subdir"));

    const result = await tool.execute({ path: tmpDir }, makeCtx());
    expect(result.output).toContain("file.txt");
    expect(result.output).toContain("subdir/");
  });

  test("sorts alphabetically case-insensitive", async () => {
    await writeFile(join(tmpDir, "Banana.txt"), "");
    await writeFile(join(tmpDir, "apple.txt"), "");
    await writeFile(join(tmpDir, "cherry.txt"), "");

    const result = await tool.execute({ path: tmpDir }, makeCtx());
    const lines = result.output.split("\n");
    expect(lines[0]).toBe("apple.txt");
    expect(lines[1]).toBe("Banana.txt");
    expect(lines[2]).toBe("cherry.txt");
  });

  test("appends / suffix to directories", async () => {
    await mkdir(join(tmpDir, "mydir"));
    const result = await tool.execute({ path: tmpDir }, makeCtx());
    expect(result.output).toContain("mydir/");
  });

  test("returns error for missing directory", async () => {
    const result = await tool.execute({ path: join(tmpDir, "nonexistent") }, makeCtx());
    expect(result.output).toContain("Error listing directory");
    expect(result.metadata?.error).toBe(true);
  });

  test("caps at 500 entries", async () => {
    // Create 510 files
    for (let i = 0; i < 510; i++) {
      await writeFile(join(tmpDir, `file-${String(i).padStart(4, "0")}.txt`), "");
    }

    const result = await tool.execute({ path: tmpDir }, makeCtx());
    const _lines = result.output.split("\n").filter(Boolean);
    // 500 files + truncation message
    expect(result.output).toContain("more entries not shown");
  });
});
