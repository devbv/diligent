import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGlobTool } from "../src/tools/glob";
import type { ToolContext } from "../src/tool/types";

function makeCtx(): ToolContext {
  return {
    toolCallId: "tc_test",
    signal: new AbortController().signal,
    approve: async () => true,
  };
}

// Check if rg is available
async function hasRipgrep(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["rg", "--version"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

describe("glob tool", () => {
  let tmpDir: string;
  let rgAvailable: boolean;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "glob-test-"));
    rgAvailable = await hasRipgrep();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("finds files matching pattern", async () => {
    if (!rgAvailable) return; // skip if rg not installed

    await writeFile(join(tmpDir, "app.ts"), "");
    await writeFile(join(tmpDir, "app.js"), "");
    await writeFile(join(tmpDir, "readme.md"), "");

    const tool = createGlobTool(tmpDir);
    const result = await tool.execute({ pattern: "*.ts" }, makeCtx());
    expect(result.output).toContain("app.ts");
    expect(result.output).not.toContain("app.js");
    expect(result.output).not.toContain("readme.md");
  });

  test("searches in specified path", async () => {
    if (!rgAvailable) return;

    await mkdir(join(tmpDir, "src"));
    await writeFile(join(tmpDir, "src", "index.ts"), "");
    await writeFile(join(tmpDir, "root.ts"), "");

    const tool = createGlobTool(tmpDir);
    const result = await tool.execute({ pattern: "*.ts", path: join(tmpDir, "src") }, makeCtx());
    expect(result.output).toContain("index.ts");
    expect(result.output).not.toContain("root.ts");
  });

  test("returns no matches message for empty results", async () => {
    if (!rgAvailable) return;

    const tool = createGlobTool(tmpDir);
    const result = await tool.execute({ pattern: "*.xyz" }, makeCtx());
    expect(result.output).toContain("No files found");
  });

  test("respects nested glob pattern", async () => {
    if (!rgAvailable) return;

    await mkdir(join(tmpDir, "src", "components"), { recursive: true });
    await writeFile(join(tmpDir, "src", "index.ts"), "");
    await writeFile(join(tmpDir, "src", "components", "Button.ts"), "");

    const tool = createGlobTool(tmpDir);
    const result = await tool.execute({ pattern: "**/*.ts" }, makeCtx());
    expect(result.output).toContain("index.ts");
    expect(result.output).toContain("Button.ts");
  });
});
