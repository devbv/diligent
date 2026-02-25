import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../src/tool/types";
import { createEditTool } from "../src/tools/edit";

function makeCtx(): ToolContext {
  return {
    toolCallId: "tc_test",
    signal: new AbortController().signal,
    approve: async () => true,
  };
}

describe("edit tool", () => {
  let tmpDir: string;
  const tool = createEditTool();

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "edit-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("replaces exact match and returns diff", async () => {
    const filePath = join(tmpDir, "test.ts");
    await writeFile(filePath, 'const name = "old";\nconsole.log(name);\n');

    const result = await tool.execute(
      {
        file_path: filePath,
        old_string: '"old"',
        new_string: '"new"',
      },
      makeCtx(),
    );

    expect(result.output).toContain("-");
    expect(result.output).toContain("+");

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain('"new"');
    expect(content).not.toContain('"old"');
  });

  test("rejects zero matches", async () => {
    const filePath = join(tmpDir, "test.ts");
    await writeFile(filePath, "const a = 1;\n");

    const result = await tool.execute(
      {
        file_path: filePath,
        old_string: "nonexistent string",
        new_string: "replacement",
      },
      makeCtx(),
    );

    expect(result.output).toContain("old_string not found");
    expect(result.metadata?.error).toBe(true);
  });

  test("rejects multiple matches", async () => {
    const filePath = join(tmpDir, "test.ts");
    await writeFile(filePath, "foo\nbar\nfoo\nbaz\n");

    const result = await tool.execute(
      {
        file_path: filePath,
        old_string: "foo",
        new_string: "qux",
      },
      makeCtx(),
    );

    expect(result.output).toContain("found 2 times");
    expect(result.metadata?.error).toBe(true);

    // File should be unchanged
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("foo\nbar\nfoo\nbaz\n");
  });

  test("returns error for missing file", async () => {
    const result = await tool.execute(
      {
        file_path: join(tmpDir, "nonexistent.txt"),
        old_string: "a",
        new_string: "b",
      },
      makeCtx(),
    );

    expect(result.output).toContain("Error reading file");
    expect(result.metadata?.error).toBe(true);
  });

  test("handles multi-line replacements", async () => {
    const filePath = join(tmpDir, "test.ts");
    await writeFile(filePath, "function foo() {\n  return 1;\n}\n");

    const _result = await tool.execute(
      {
        file_path: filePath,
        old_string: "function foo() {\n  return 1;\n}",
        new_string: "function foo() {\n  return 42;\n}",
      },
      makeCtx(),
    );

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("return 42");
  });
});
