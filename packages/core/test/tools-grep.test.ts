import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGrepTool } from "../src/tools/grep";
import type { ToolContext } from "../src/tool/types";

function makeCtx(): ToolContext {
  return {
    toolCallId: "tc_test",
    signal: new AbortController().signal,
    approve: async () => true,
  };
}

async function hasRipgrep(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["rg", "--version"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

describe("grep tool", () => {
  let tmpDir: string;
  let rgAvailable: boolean;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "grep-test-"));
    rgAvailable = await hasRipgrep();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("finds regex matches with line numbers", async () => {
    if (!rgAvailable) return;

    await writeFile(join(tmpDir, "test.ts"), "const foo = 1;\nconst bar = 2;\nconst fooBar = 3;\n");

    const tool = createGrepTool(tmpDir);
    const result = await tool.execute({ pattern: "foo" }, makeCtx());
    expect(result.output).toContain("foo");
    expect(result.output).toContain(":1:");
    expect(result.output).toContain(":3:");
    expect(result.truncateDirection).toBe("head");
  });

  test("supports case-insensitive search", async () => {
    if (!rgAvailable) return;

    await writeFile(join(tmpDir, "test.ts"), "Hello\nhello\nHELLO\n");

    const tool = createGrepTool(tmpDir);
    const result = await tool.execute({ pattern: "hello", ignore_case: true }, makeCtx());
    expect(result.output).toContain("Hello");
    expect(result.output).toContain("hello");
    expect(result.output).toContain("HELLO");
  });

  test("filters by include pattern", async () => {
    if (!rgAvailable) return;

    await writeFile(join(tmpDir, "app.ts"), "TODO: fix this\n");
    await writeFile(join(tmpDir, "app.js"), "TODO: fix that\n");

    const tool = createGrepTool(tmpDir);
    const result = await tool.execute({ pattern: "TODO", include: "*.ts" }, makeCtx());
    expect(result.output).toContain("app.ts");
    expect(result.output).not.toContain("app.js");
  });

  test("shows context lines", async () => {
    if (!rgAvailable) return;

    await writeFile(join(tmpDir, "test.ts"), "line1\nline2\nMATCH\nline4\nline5\n");

    const tool = createGrepTool(tmpDir);
    const result = await tool.execute({ pattern: "MATCH", context: 1 }, makeCtx());
    expect(result.output).toContain("line2");
    expect(result.output).toContain("MATCH");
    expect(result.output).toContain("line4");
  });

  test("returns no matches message for empty results", async () => {
    if (!rgAvailable) return;

    await writeFile(join(tmpDir, "test.ts"), "nothing here\n");

    const tool = createGrepTool(tmpDir);
    const result = await tool.execute({ pattern: "nonexistent" }, makeCtx());
    expect(result.output).toContain("No matches found");
  });
});
