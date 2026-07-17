// @summary Tests for downscaleImageIfNeeded — caps long edge, preserves aspect, passes through
// small/undecodable/GIF images unchanged.
import { beforeAll, describe, expect, test } from "bun:test";
import type { ImageBlock } from "@diligent/core/message-contract";
import type { Tool, ToolContext } from "@diligent/core/tool-contract";
// @ts-expect-error -- file import yields a path string at runtime
import pngWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm" with { type: "file" };
import decodePng, { init as initPngDecode } from "@jsquash/png/decode";
import encodePng, { init as initPngEncode } from "@jsquash/png/encode";
import { z } from "zod";
import {
  DEFAULT_MAX_LONG_EDGE,
  downscaleImageIfNeeded,
  imageDimensionsFromHeader,
  withImageDownscaling,
} from "../../src/llm/image-resize";

// Build a solid-white image of the given size and encode it to a real PNG for use as a fixture.
function solidImage(width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  return { data, width, height };
}

// Deterministic pseudo-random noise (LCG) — incompressible pixels for byte-backstop fixtures.
function noiseImage(width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 0x12345678;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = seed & 0xff;
  }
  return { data, width, height };
}

let smallPng: ArrayBuffer;
let largePng: ArrayBuffer;

beforeAll(async () => {
  const mod = await WebAssembly.compile(await Bun.file(pngWasm).arrayBuffer());
  await initPngDecode(mod);
  await initPngEncode(mod);
  smallPng = await encodePng(solidImage(100, 80));
  largePng = await encodePng(solidImage(3000, 2000));
});

describe("downscaleImageIfNeeded", () => {
  test("returns the original bytes unchanged when the long edge is under the cap", async () => {
    const result = await downscaleImageIfNeeded(smallPng, "image/png");
    expect(result.bytes).toBe(smallPng);
    expect(result.mediaType).toBe("image/png");
  });

  test("downscales an oversized PNG so the long edge equals the cap", async () => {
    const result = await downscaleImageIfNeeded(largePng, "image/png");
    expect(result.bytes).not.toBe(largePng);
    expect(result.mediaType).toBe("image/png");
    const decoded = await decodePng(result.bytes);
    expect(Math.max(decoded.width, decoded.height)).toBe(DEFAULT_MAX_LONG_EDGE);
  });

  test("preserves aspect ratio when downscaling (3000x2000 -> 1568x1045)", async () => {
    const result = await downscaleImageIfNeeded(largePng, "image/png");
    const decoded = await decodePng(result.bytes);
    expect(decoded.width).toBe(1568);
    expect(decoded.height).toBe(1045);
  });

  test("honors a custom maxLongEdge", async () => {
    const result = await downscaleImageIfNeeded(largePng, "image/png", 800);
    const decoded = await decodePng(result.bytes);
    expect(Math.max(decoded.width, decoded.height)).toBe(800);
  });

  test("passes GIF bytes through unchanged (no codec; preserve animation)", async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x27, 0x10, 0x27]).buffer;
    const result = await downscaleImageIfNeeded(gif, "image/gif");
    expect(result.bytes).toBe(gif);
    expect(result.mediaType).toBe("image/gif");
  });

  test("passes through bytes that the codec cannot decode", async () => {
    const garbage = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]).buffer;
    const result = await downscaleImageIfNeeded(garbage, "image/png");
    expect(result.bytes).toBe(garbage);
  });

  test("does not crash on an extreme aspect ratio (short edge clamps to 1, not 0)", async () => {
    const wide = await encodePng(solidImage(3200, 1));
    const result = await downscaleImageIfNeeded(wide, "image/png");
    const decoded = await decodePng(result.bytes);
    expect(decoded.width).toBe(DEFAULT_MAX_LONG_EDGE);
    expect(decoded.height).toBe(1); // clamped up from round(0.49)=0
  });

  test("refuses to decode an image past the pixel ceiling (passes original through)", async () => {
    // A 24-byte PNG header claiming 20000x20000 (400 MP) — no real pixels. The header guard must
    // return it untouched WITHOUT attempting a (here impossible, otherwise OOM-y) decode.
    const header = pngHeaderOnly(20000, 20000);
    const result = await downscaleImageIfNeeded(header, "image/png");
    expect(result.bytes).toBe(header);
  });

  test("byte backstop: converts an in-cap but multi-MB PNG to lossy WebP", async () => {
    // Deterministic noise defeats PNG compression: 1200x1200 RGBA noise encodes to ~5.7 MB while
    // staying within the 1568px pixel cap, so only the byte trigger can catch it.
    const noise = await encodePng(noiseImage(1200, 1200));
    expect(noise.byteLength).toBeGreaterThan(2 * 1024 * 1024);

    const result = await downscaleImageIfNeeded(noise, "image/png");
    expect(result.mediaType).toBe("image/webp");
    expect(result.bytes.byteLength).toBeLessThan(2 * 1024 * 1024);
  });

  test("byte backstop: keeps the original when a re-encode cannot shrink it", async () => {
    // A small solid PNG is already tiny; nothing to do on either trigger.
    const result = await downscaleImageIfNeeded(smallPng, "image/png");
    expect(result.bytes).toBe(smallPng);
  });
});

describe("imageDimensionsFromHeader", () => {
  test("reads PNG dimensions from the header", () => {
    expect(imageDimensionsFromHeader(new Uint8Array(pngHeaderOnly(3000, 2000)), "image/png")).toEqual({
      width: 3000,
      height: 2000,
    });
  });

  test("reads real encoded-PNG dimensions", async () => {
    const png = await encodePng(solidImage(640, 480));
    expect(imageDimensionsFromHeader(new Uint8Array(png), "image/png")).toEqual({ width: 640, height: 480 });
  });

  test("returns null for a truncated header", () => {
    const tiny = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(imageDimensionsFromHeader(tiny, "image/png")).toBeNull();
  });
});

describe("withImageDownscaling", () => {
  function toolReturning(images: ImageBlock[] | undefined): Tool {
    return {
      name: "fake",
      description: "",
      parameters: z.object({}),
      async execute() {
        return { output: "ok", ...(images ? { outputImages: images } : {}) };
      },
    } as unknown as Tool;
  }

  test("downscales oversized images a tool returns", async () => {
    const block: ImageBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: Buffer.from(largePng).toString("base64") },
    };
    const wrapped = withImageDownscaling(toolReturning([block]));
    const result = await wrapped.execute({}, {} as ToolContext);
    const out = result.outputImages?.[0];
    expect(out).toBeDefined();
    const decoded = await decodePng(Buffer.from(out!.source.data, "base64").buffer as ArrayBuffer);
    expect(Math.max(decoded.width, decoded.height)).toBe(DEFAULT_MAX_LONG_EDGE);
  });

  test("passes through a tool that returns no images", async () => {
    const wrapped = withImageDownscaling(toolReturning(undefined));
    const result = await wrapped.execute({}, {} as ToolContext);
    expect(result.output).toBe("ok");
    expect(result.outputImages).toBeUndefined();
  });
});

// Build only a PNG header (signature + IHDR with width/height); no pixel data.
function pngHeaderOnly(width: number, height: number): ArrayBuffer {
  const b = new Uint8Array(26);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR chunk length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b.buffer;
}
