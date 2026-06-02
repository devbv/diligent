// @summary Tests for read_image tool — base64 encoding, size limits, MIME validation, symlinks, abort
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@diligent/core/tool/types";
import { createReadImageTool } from "@diligent/runtime/tools";

function makeCtx(signal?: AbortSignal): ToolContext {
  return {
    toolCallId: "tc_test",
    signal: signal ?? new AbortController().signal,
    abort: () => {},
  };
}

// Minimal 1x1 PNG (red pixel), borrowed from common test fixtures.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, "base64");

// Minimal JPEG (SOI/APP0/SOF0/etc. truncated header is enough to pass FF D8 FF sniff)
const TINY_JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0xff, 0xd9,
]);

// "GIF87a" + minimal trailer
const TINY_GIF_BYTES = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b,
]);

// "RIFF...WEBP" header (12 bytes is enough for the sniff)
const TINY_WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00,
  0x00, 0x2f, 0x00, 0x00, 0x00, 0x00,
]);

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
    await writeFile(filePath, TINY_PNG_BYTES);

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

  test("loads a real JPEG", async () => {
    const filePath = join(tmpDir, "photo.jpg");
    await writeFile(filePath, TINY_JPEG_BYTES);
    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.metadata?.error).toBeUndefined();
    expect(result.outputImages?.[0]?.source.media_type).toBe("image/jpeg");
  });

  test("loads a real GIF", async () => {
    const filePath = join(tmpDir, "anim.gif");
    await writeFile(filePath, TINY_GIF_BYTES);
    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.metadata?.error).toBeUndefined();
    expect(result.outputImages?.[0]?.source.media_type).toBe("image/gif");
  });

  test("loads a real WebP", async () => {
    const filePath = join(tmpDir, "shot.webp");
    await writeFile(filePath, TINY_WEBP_BYTES);
    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.metadata?.error).toBeUndefined();
    expect(result.outputImages?.[0]?.source.media_type).toBe("image/webp");
  });

  test("rejects extension/content MIME mismatch (.jpg with PNG bytes)", async () => {
    const filePath = join(tmpDir, "photo.jpg");
    await writeFile(filePath, TINY_PNG_BYTES);

    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("image/jpeg");
    expect(result.output).toContain("image/png");
    expect(result.outputImages).toBeUndefined();
  });

  test("rejects non-image extensions", async () => {
    const filePath = join(tmpDir, "notes.txt");
    await writeFile(filePath, "hello");

    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("Unsupported image type");
    expect(result.outputImages).toBeUndefined();
  });

  test("rejects pure dotfile named like an image (/foo/.png)", async () => {
    const filePath = join(tmpDir, ".png");
    await writeFile(filePath, "fake");
    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("Unsupported image type");
  });

  test("rejects non-existent files", async () => {
    const result = await tool.execute({ file_path: join(tmpDir, "missing.png") }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("File not found");
  });

  test("rejects empty files", async () => {
    const filePath = join(tmpDir, "empty.png");
    await writeFile(filePath, "");
    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("empty");
  });

  test("rejects files exceeding 5 MB", async () => {
    const filePath = join(tmpDir, "big.png");
    // 5 MB + 1 byte of zeros — past the cap, but valid PNG header for media check.
    await writeFile(filePath, Buffer.concat([TINY_PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]));
    const result = await tool.execute({ file_path: filePath }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("5 MB limit");
  });

  test("rejects relative paths", async () => {
    const result = await tool.execute({ file_path: "relative/path.png" }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("must be absolute");
  });

  test("rejects symlink whose target has a different image type", async () => {
    const target = join(tmpDir, "real.gif");
    await writeFile(target, TINY_GIF_BYTES);
    const link = join(tmpDir, "fake.png");
    await symlink(target, link);
    const result = await tool.execute({ file_path: link }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("Symlink");
  });

  test("rejects symlink to a non-image", async () => {
    const target = join(tmpDir, "secret.txt");
    await writeFile(target, "sensitive");
    const link = join(tmpDir, "shot.png");
    await symlink(target, link);
    const result = await tool.execute({ file_path: link }, makeCtx());
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("Symlink");
  });

  test("honors AbortSignal — returns error when pre-aborted", async () => {
    const filePath = join(tmpDir, "pixel.png");
    await writeFile(filePath, TINY_PNG_BYTES);
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute({ file_path: filePath }, makeCtx(controller.signal));
    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("Aborted");
  });
});
