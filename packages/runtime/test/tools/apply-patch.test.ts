// @summary Tests for codex-style apply_patch tool semantics
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@diligent/core/tool-contract";
import { createApplyPatchTool, parsePatch } from "@diligent/runtime/tools";

function makeCtx(): ToolContext {
  return {
    toolCallId: "tc_test",
    signal: new AbortController().signal,
    abort: () => {},
  };
}

describe("apply_patch tool", () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createApplyPatchTool>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "apply-patch-test-"));
    tool = createApplyPatchTool(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("applies add/update/delete together", async () => {
    const modify = join(tmpDir, "modify.txt");
    const removePath = join(tmpDir, "remove.txt");
    await writeFile(modify, "line1\nline2\n", "utf-8");
    await writeFile(removePath, "obsolete\n", "utf-8");

    const patch = [
      "*** Begin Patch",
      "*** Add File: nested/new.txt",
      "+created",
      "*** Update File: modify.txt",
      "@@",
      "-line2",
      "+changed",
      "*** Delete File: remove.txt",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, makeCtx());

    expect(result.render).toBeDefined();
    expect(result.render?.outputSummary).toBe("3 files patched");
    expect(result.render?.blocks[0]).toMatchObject({ type: "diff" });
    expect(result.output).toContain("Success. Updated the following files:");
    expect(result.output).toContain("A nested/new.txt");
    expect(result.output).toContain("M modify.txt");
    expect(result.output).toContain("D remove.txt");
    expect(await readFile(join(tmpDir, "nested/new.txt"), "utf-8")).toBe("created\n");
    expect(await readFile(modify, "utf-8")).toBe("line1\nchanged\n");
    await expect(readFile(removePath, "utf-8")).rejects.toThrow();
  });

  test("supports update move with strict context", async () => {
    const from = join(tmpDir, "old/name.txt");
    await mkdir(join(tmpDir, "old"), { recursive: true });
    await writeFile(from, "old content\n", "utf-8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: old/name.txt",
      "*** Move to: renamed/dir/name.txt",
      "@@",
      "-old content",
      "+new content",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, makeCtx());
    expect(result.output).toContain("M renamed/dir/name.txt");
    await expect(readFile(from, "utf-8")).rejects.toThrow();
    expect(await readFile(join(tmpDir, "renamed/dir/name.txt"), "utf-8")).toBe("new content\n");
  });

  test("add overwrites existing file", async () => {
    const target = join(tmpDir, "duplicate.txt");
    await writeFile(target, "old content\n", "utf-8");

    const patch = ["*** Begin Patch", "*** Add File: duplicate.txt", "+new content", "*** End Patch"].join("\n");

    const result = await tool.execute({ patch }, makeCtx());

    expect(result.metadata?.error).not.toBe(true);
    expect(result.output).toContain("A duplicate.txt");
    expect(await readFile(target, "utf-8")).toBe("new content\n");
  });

  test("move overwrites existing destination", async () => {
    const from = join(tmpDir, "old/name.txt");
    const destination = join(tmpDir, "renamed/dir/name.txt");
    await mkdir(join(tmpDir, "old"), { recursive: true });
    await mkdir(join(tmpDir, "renamed/dir"), { recursive: true });
    await writeFile(from, "from\n", "utf-8");
    await writeFile(destination, "existing\n", "utf-8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: old/name.txt",
      "*** Move to: renamed/dir/name.txt",
      "@@",
      "-from",
      "+new",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, makeCtx());

    expect(result.metadata?.error).not.toBe(true);
    expect(result.output).toContain("M renamed/dir/name.txt");
    await expect(readFile(from, "utf-8")).rejects.toThrow();
    expect(await readFile(destination, "utf-8")).toBe("new\n");
  });

  test("rejects malformed patch envelope", async () => {
    const result = await tool.execute({ patch: "*** Begin Patch\n*** Add File: x.txt\n+hi" }, makeCtx());
    expect(result.render?.blocks[0]).toMatchObject({ type: "text", title: "Input" });
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("apply_patch verification failed");
  });

  test("rejects empty patch", async () => {
    const result = await tool.execute({ patch: "*** Begin Patch\n*** End Patch" }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("patch rejected: empty patch");
  });

  test("rejects missing context in update", async () => {
    const target = join(tmpDir, "target.txt");
    await writeFile(target, "a\nb\nc\n", "utf-8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: target.txt",
      "@@",
      "-missing",
      "+changed",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("Failed to find expected lines");
    expect(await readFile(target, "utf-8")).toBe("a\nb\nc\n");
  });

  test("failure after partial success leaves earlier changes", async () => {
    const created = join(tmpDir, "created.txt");

    const patch = [
      "*** Begin Patch",
      "*** Add File: created.txt",
      "+hello",
      "*** Update File: missing.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, makeCtx());

    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("Failed to read file to update");
    expect(await readFile(created, "utf-8")).toBe("hello\n");
  });

  test("rejects absolute paths in patch headers", async () => {
    const target = join(tmpDir, "target.txt");
    await writeFile(target, "a\n", "utf-8");

    const patch = ["*** Begin Patch", `*** Update File: ${target}`, "@@", "-a", "+b", "*** End Patch"].join("\n");

    const result = await tool.execute({ patch }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("Patch paths must be relative");
  });

  test("rejects Windows extended-length absolute paths in patch headers", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: \\\\?\\C:\\repo\\target.txt",
      "@@",
      "-a",
      "+b",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, makeCtx());

    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("Patch paths must be relative");
  });

  test("applies same-file multiple hunks correctly even when order is reversed", async () => {
    const target = join(tmpDir, "multi.txt");
    await writeFile(target, "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "utf-8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: multi.txt",
      "@@",
      "-h",
      "+H",
      "+H2",
      "@@",
      "-b",
      "+B",
      "+B2",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, makeCtx());
    expect(result.metadata?.error).not.toBe(true);
    expect(await readFile(target, "utf-8")).toBe("a\nB\nB2\nc\nd\ne\nf\ng\nH\nH2\ni\nj\n");
  });
});

describe("unicode normalization gaps vs codex-rs", () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createApplyPatchTool>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "apply-patch-unicode-"));
    tool = createApplyPatchTool(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function assertUnicodePatchApplied(fileContent: string, patchOldLine: string): Promise<void> {
    const target = join(tmpDir, "unicode.txt");
    await writeFile(target, `before\n${fileContent}\nafter\n`, "utf-8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: unicode.txt",
      "@@",
      ` before`,
      `-${patchOldLine}`,
      `+replaced`,
      ` after`,
      "*** End Patch",
    ].join("\n");
    const result = await tool.execute({ patch }, makeCtx());
    expect(result.metadata?.error).not.toBe(true);
    const content = await readFile(target, "utf-8");
    expect(content).toBe("before\nreplaced\nafter\n");
  }

  test("matches U+2212 mathematical minus sign via ascii dash in patch", async () => {
    await assertUnicodePatchApplied("a\u2212b", "a-b");
  });

  test("matches U+2002 en-space via regular space in patch", async () => {
    await assertUnicodePatchApplied("hello\u2002world", "hello world");
  });

  test("matches U+2003 em-space via regular space in patch", async () => {
    await assertUnicodePatchApplied("hello\u2003world", "hello world");
  });

  test("matches U+2004 three-per-em space via regular space in patch", async () => {
    await assertUnicodePatchApplied("hello\u2004world", "hello world");
  });

  test("matches U+2005 four-per-em space via regular space in patch", async () => {
    await assertUnicodePatchApplied("hello\u2005world", "hello world");
  });

  test("matches U+2009 thin space via regular space in patch", async () => {
    await assertUnicodePatchApplied("hello\u2009world", "hello world");
  });

  test("matches U+200A hair space via regular space in patch", async () => {
    await assertUnicodePatchApplied("hello\u200Aworld", "hello world");
  });

  test("matches U+202F narrow no-break space via regular space in patch", async () => {
    await assertUnicodePatchApplied("hello\u202Fworld", "hello world");
  });

  test("matches U+205F medium mathematical space via regular space in patch", async () => {
    await assertUnicodePatchApplied("hello\u205Fworld", "hello world");
  });

  test("matches U+3000 ideographic space via regular space in patch", async () => {
    await assertUnicodePatchApplied("hello\u3000world", "hello world");
  });
});

describe("heredoc stripping", () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createApplyPatchTool>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "apply-patch-heredoc-"));
    tool = createApplyPatchTool(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const ADD_PATCH_BODY = ["*** Begin Patch", "*** Add File: created.txt", "+hello", "*** End Patch"].join("\n");

  test("strips bash -lc double-quoted heredoc with literal \\n escapes", async () => {
    const escaped = ADD_PATCH_BODY.replace(/\n/g, "\\n");
    const patch = `bash -lc "apply_patch <<'EOF'\\n${escaped}\\nEOF"`;
    const result = await tool.execute({ patch }, makeCtx());
    expect(result.metadata?.error).not.toBe(true);
    expect(await readFile(join(tmpDir, "created.txt"), "utf-8")).toBe("hello\n");
  });

  test("strips bash -lc double-quoted heredoc with actual newlines", async () => {
    const patch = `bash -lc "apply_patch <<'EOF'\n${ADD_PATCH_BODY}\nEOF"`;
    const result = await tool.execute({ patch }, makeCtx());
    expect(result.metadata?.error).not.toBe(true);
    expect(await readFile(join(tmpDir, "created.txt"), "utf-8")).toBe("hello\n");
  });

  test("strips standalone apply_patch <<'EOF' heredoc", async () => {
    const patch = `apply_patch <<'EOF'\n${ADD_PATCH_BODY}\nEOF`;
    const result = await tool.execute({ patch }, makeCtx());
    expect(result.metadata?.error).not.toBe(true);
    expect(await readFile(join(tmpDir, "created.txt"), "utf-8")).toBe("hello\n");
  });

  test("strips cd && apply_patch <<'EOF' heredoc (ignores cd path)", async () => {
    const patch = `cd /some/path && apply_patch <<'EOF'\n${ADD_PATCH_BODY}\nEOF`;
    const result = await tool.execute({ patch }, makeCtx());
    expect(result.metadata?.error).not.toBe(true);
    expect(await readFile(join(tmpDir, "created.txt"), "utf-8")).toBe("hello\n");
  });
});

describe("strict vs lenient parsing mode", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "apply-patch-strict-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const ADD_PATCH_BODY = ["*** Begin Patch", "*** Add File: strict.txt", "+hello", "*** End Patch"].join("\n");

  test("lenient mode (default) accepts heredoc-wrapped patch", async () => {
    const tool = createApplyPatchTool(tmpDir);
    const patch = `apply_patch <<'EOF'\n${ADD_PATCH_BODY}\nEOF`;
    const result = await tool.execute({ patch }, makeCtx());
    expect(result.metadata?.error).not.toBe(true);
    expect(await readFile(join(tmpDir, "strict.txt"), "utf-8")).toBe("hello\n");
  });

  test("strict mode rejects heredoc-wrapped patch", async () => {
    const tool = createApplyPatchTool(tmpDir, undefined, { strict: true });
    const patch = `apply_patch <<'EOF'\n${ADD_PATCH_BODY}\nEOF`;
    const result = await tool.execute({ patch }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toMatch(/invalid patch format/i);
  });

  test("strict mode accepts bare patch", async () => {
    const tool = createApplyPatchTool(tmpDir, undefined, { strict: true });
    const result = await tool.execute({ patch: ADD_PATCH_BODY }, makeCtx());
    expect(result.metadata?.error).not.toBe(true);
    expect(await readFile(join(tmpDir, "strict.txt"), "utf-8")).toBe("hello\n");
  });

  test("parsePatch strict mode rejects heredoc-wrapped patch", () => {
    const patch = `apply_patch <<'EOF'\n${ADD_PATCH_BODY}\nEOF`;
    expect(() => parsePatch(patch, { strict: true })).toThrow(/invalid patch format/i);
  });

  test("parsePatch lenient mode (default) accepts heredoc-wrapped patch", () => {
    const patch = `apply_patch <<'EOF'\n${ADD_PATCH_BODY}\nEOF`;
    expect(parsePatch(patch)).toHaveLength(1);
  });
});
