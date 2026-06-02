// @summary Tests for image-sidecar externalization + materialization round-trip
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessageEntry } from "@diligent/runtime/session";
import { externalizeEntryImages, materializeEntryImages } from "@diligent/runtime/session";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function makeToolResultEntry(images: Array<{ data: string }>): SessionMessageEntry {
  return {
    type: "message",
    id: "e0",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "tool_result",
      toolCallId: "tc1",
      toolName: "read_image",
      output: "Loaded image x.png",
      outputImages: images.map((img) => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: img.data },
      })),
      isError: false,
      timestamp: 0,
    },
  };
}

describe("image-sidecar", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sidecar-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("externalize then materialize round-trips base64 data", async () => {
    const original = makeToolResultEntry([{ data: TINY_PNG_BASE64 }]);
    const externalized = await externalizeEntryImages(dir, original);
    const block = (externalized as SessionMessageEntry).message;
    if (block.role !== "tool_result") throw new Error("unreachable");
    expect(block.outputImages?.[0]?.source.data.startsWith("blob:")).toBe(true);
    expect(block.output).toBe("Loaded image x.png");

    // A blob file was created.
    const files = await readdir(join(dir, "blobs"));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.bin$/);

    const materialized = await materializeEntryImages(dir, externalized);
    const restored = (materialized as SessionMessageEntry).message;
    if (restored.role !== "tool_result") throw new Error("unreachable");
    expect(restored.outputImages?.[0]?.source.data).toBe(TINY_PNG_BASE64);
  });

  test("deduplicates blobs with identical content", async () => {
    const entry = makeToolResultEntry([{ data: TINY_PNG_BASE64 }, { data: TINY_PNG_BASE64 }]);
    await externalizeEntryImages(dir, entry);
    const files = await readdir(join(dir, "blobs"));
    expect(files.length).toBe(1);
  });

  test("pass-through entries without outputImages", async () => {
    const entry: SessionMessageEntry = {
      type: "message",
      id: "e0",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "hi", timestamp: 0 },
    };
    const externalized = await externalizeEntryImages(dir, entry);
    expect(externalized).toBe(entry);
  });

  test("materialize passes through literal base64 (backward compat for pre-sidecar sessions)", async () => {
    const entry = makeToolResultEntry([{ data: TINY_PNG_BASE64 }]);
    const materialized = await materializeEntryImages(dir, entry);
    const block = (materialized as SessionMessageEntry).message;
    if (block.role !== "tool_result") throw new Error("unreachable");
    expect(block.outputImages?.[0]?.source.data).toBe(TINY_PNG_BASE64);
  });

  test("materialize falls back to placeholder when blob is missing on disk", async () => {
    const entry = makeToolResultEntry([{ data: TINY_PNG_BASE64 }]);
    const externalized = await externalizeEntryImages(dir, entry);
    // Wipe the blob dir to simulate a corrupted session.
    await rm(join(dir, "blobs"), { recursive: true, force: true });
    const materialized = await materializeEntryImages(dir, externalized);
    const block = (materialized as SessionMessageEntry).message;
    if (block.role !== "tool_result") throw new Error("unreachable");
    expect(block.outputImages?.[0]?.source.data).toBeDefined();
    expect(block.outputImages?.[0]?.source.data.startsWith("blob:")).toBe(false);
  });
});
