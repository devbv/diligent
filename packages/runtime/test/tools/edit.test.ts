// @summary Tests for edit and multi_edit tool summaries and diff payloads
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@diligent/core/tool-contract";
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

  test("documents the empty-old-string create mode", () => {
    const tool = createEditTool();
    expect(tool.description).toContain("To create a new file");
    expect(tool.description).toContain("old_string to an empty string");
  });

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
});
