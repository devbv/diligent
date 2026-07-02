// @summary Tests for grep/ripgrep tool with pattern matching and filtering
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@diligent/core/tool/types";
import { createGrepTool } from "@diligent/runtime/tools";

function makeCtx(): ToolContext {
  return {
    toolCallId: "tc_test",
    signal: new AbortController().signal,
    abort: () => {},
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
    expect(result.render).toBeDefined();
    expect(result.render?.blocks[0]).toMatchObject({ type: "summary" });
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
    expect(result.render).toBeDefined();
    expect(result.output).toContain("No matches found");
    expect(result.render?.outputSummary).toBe("0 matches found");
    const listBlock = result.render?.blocks.find((block) => block.type === "list");
    expect(listBlock).toMatchObject({ type: "list", title: "└ Found 0 matches", items: [] });
  });

  test("resolves relative path against cwd", async () => {
    if (!rgAvailable) return;

    await writeFile(join(tmpDir, "relative.ts"), "const marker = 1;\n");
    const tool = createGrepTool(tmpDir);
    const result = await tool.execute({ pattern: "marker", path: "." }, makeCtx());
    expect(result.output).toContain("relative.ts");
  });

  test("returns error for filesystem root path", async () => {
    const tool = createGrepTool(tmpDir);
    const result = await tool.execute({ pattern: "marker", path: "/" }, makeCtx());
    expect(result.render?.blocks[0]).toMatchObject({ type: "text", title: "Output" });
    expect(result.output).toContain("refusing to grep the filesystem root");
    expect(result.metadata?.error).toBe(true);
  });
});
