// @summary Tests for edit and multi_edit tool summaries and diff payloads
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@diligent/core/tool/types";
import { createEditTool, createMultiEditTool } from "@diligent/runtime/tools";

function makeCtx(): ToolContext {
  return {
    toolCallId: "tc_edit",
    signal: new AbortController().signal,
    abort: () => {},
  };
}

describe("edit tools", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "edit-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("edit summary reports applied replacement count", async () => {
    const filePath = join(tmpDir, "file.txt");
    await writeFile(filePath, "hello world\n");

    const tool = createEditTool();
    const result = await tool.execute(
      { file_path: filePath, old_string: "world", new_string: "team", replace_all: false },
      makeCtx(),
    );

    expect(result.render?.outputSummary).toBe("1 edit applied");
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("hello team");
  });

  test("edit metadata includes oldStringCountAfter and newStringCountAfter", async () => {
    const filePath = join(tmpDir, "file.txt");
    await writeFile(filePath, "foo bar foo\n");

    const tool = createEditTool();

    // replace_all: old string gone, new string present
    const result = await tool.execute(
      { file_path: filePath, old_string: "foo", new_string: "baz", replace_all: true },
      makeCtx(),
    );

    expect(result.metadata).toMatchObject({
      replacements: 2,
      oldStringCountAfter: 0,
      newStringCountAfter: 2,
    });
  });

  test("edit metadata: old string absent, new string present after single replacement", async () => {
    const filePath = join(tmpDir, "file.txt");
    await writeFile(filePath, "unique token here\n");

    const tool = createEditTool();
    const result = await tool.execute(
      { file_path: filePath, old_string: "unique token", new_string: "replaced value", replace_all: false },
      makeCtx(),
    );

    expect(result.metadata).toMatchObject({
      replacements: 1,
      oldStringCountAfter: 0,
      newStringCountAfter: 1,
    });
  });

  test("multi_edit summary reports applied edit count", async () => {
    const filePath = join(tmpDir, "file.txt");
    await writeFile(filePath, "alpha\nbeta\n");

    const tool = createMultiEditTool();
    const result = await tool.execute(
      {
        file_path: filePath,
        edits: [
          { old_string: "alpha", new_string: "one", replace_all: false },
          { old_string: "beta", new_string: "two", replace_all: false },
        ],
      },
      makeCtx(),
    );

    expect(result.render?.outputSummary).toBe("2 edits applied");
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("one");
    expect(content).toContain("two");
  });

  test("multi_edit metadata includes per-edit readback counts from final file state", async () => {
    const filePath = join(tmpDir, "file.txt");
    await writeFile(filePath, "alpha\nbeta\n");

    const tool = createMultiEditTool();
    const result = await tool.execute(
      {
        file_path: filePath,
        edits: [
          { old_string: "alpha", new_string: "one", replace_all: false },
          { old_string: "beta", new_string: "two", replace_all: false },
        ],
      },
      makeCtx(),
    );

    expect(result.metadata).toMatchObject({ replacements: 2 });
    const editsAfter = (
      result.metadata as {
        editsAfter: Array<{
          old_string: string;
          new_string: string;
          oldStringCountAfter: number;
          newStringCountAfter: number;
        }>;
      }
    ).editsAfter;
    expect(editsAfter).toHaveLength(2);
    // first edit: "alpha" → "one"; in final file neither "alpha" nor intermediate state matters, only final
    expect(editsAfter[0]).toMatchObject({
      old_string: "alpha",
      new_string: "one",
      oldStringCountAfter: 0,
      newStringCountAfter: 1,
    });
    // second edit: "beta" → "two"
    expect(editsAfter[1]).toMatchObject({
      old_string: "beta",
      new_string: "two",
      oldStringCountAfter: 0,
      newStringCountAfter: 1,
    });
  });
});
