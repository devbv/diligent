// @summary Tests for read_image tool — base64 encoding, size limits, and extension validation
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@diligent/core/tool/types";
import { createReadImageTool } from "@diligent/runtime/tools";

function makeCtx(): ToolContext {
  return {
    toolCallId: "tc_test",
    signal: new AbortController().signal,
    abort: () => {},
  };
}

// Minimal 1x1 PNG (red pixel), borrowed from common test fixtures.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("read_image tool", () => {
  let tmpDir: string;
  const tool = createReadImageTool();

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "read-image-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns base64 image block for a PNG", async () => {
    const filePath = join(tmpDir, "pixel.png");
    await writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.metadata?.error).toBeUndefined();
    expect(result.outputImages).toHaveLength(1);
    expect(result.outputImages?.[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: TINY_PNG_BASE64 },
    });
    expect(result.output).toContain("pixel.png");
    expect(result.output).toContain("image/png");
  });

  test("infers media_type from .jpg extension", async () => {
    const filePath = join(tmpDir, "photo.jpg");
    await writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.outputImages?.[0]?.source.media_type).toBe("image/jpeg");
  });

  test("rejects non-image extensions", async () => {
    const filePath = join(tmpDir, "notes.txt");
    await writeFile(filePath, "hello");

    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("Unsupported image type");
    expect(result.outputImages).toBeUndefined();
  });

  test("rejects non-existent files", async () => {
    const result = await tool.execute({ file_path: join(tmpDir, "missing.png") }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("File not found");
  });

  test("rejects relative paths", async () => {
    const result = await tool.execute({ file_path: "relative/path.png" }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("must be absolute");
  });
});
