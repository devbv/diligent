// @summary Tests for downscaleImageIfNeeded — caps long edge, preserves aspect, passes through
// small/undecodable/GIF images unchanged.
import { beforeAll, describe, expect, test } from "bun:test";
// @ts-expect-error -- file import yields a path string at runtime
import pngWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm" with { type: "file" };
import decodePng, { init as initPngDecode } from "@jsquash/png/decode";
import encodePng, { init as initPngEncode } from "@jsquash/png/encode";
import { DEFAULT_MAX_LONG_EDGE, downscaleImageIfNeeded } from "../../src/tools/image-resize";

// Build a solid-white image of the given size and encode it to a real PNG for use as a fixture.
function solidImage(width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
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
    expect(result).toBe(smallPng);
  });

  test("downscales an oversized PNG so the long edge equals the cap", async () => {
    const result = await downscaleImageIfNeeded(largePng, "image/png");
    expect(result).not.toBe(largePng);
    const decoded = await decodePng(result);
    expect(Math.max(decoded.width, decoded.height)).toBe(DEFAULT_MAX_LONG_EDGE);
  });

  test("preserves aspect ratio when downscaling (3000x2000 -> 1568x1045)", async () => {
    const result = await downscaleImageIfNeeded(largePng, "image/png");
    const decoded = await decodePng(result);
    expect(decoded.width).toBe(1568);
    expect(decoded.height).toBe(1045);
  });

  test("honors a custom maxLongEdge", async () => {
    const result = await downscaleImageIfNeeded(largePng, "image/png", 800);
    const decoded = await decodePng(result);
    expect(Math.max(decoded.width, decoded.height)).toBe(800);
  });

  test("passes GIF bytes through unchanged (no codec; preserve animation)", async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x27, 0x10, 0x27]).buffer;
    const result = await downscaleImageIfNeeded(gif, "image/gif");
    expect(result).toBe(gif);
  });

  test("passes through bytes that the codec cannot decode", async () => {
    const garbage = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]).buffer;
    const result = await downscaleImageIfNeeded(garbage, "image/png");
    expect(result).toBe(garbage);
  });
});
