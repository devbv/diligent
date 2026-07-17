// @summary Tests localImageToBase64 downscales oversized stored images at materialize time —
// the guard for attachments persisted before upload-time downscaling existed.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- file import yields a path string at runtime
import pngWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm" with { type: "file" };
import { init as initPngDecode } from "@jsquash/png/decode";
import encodePng, { init as initPngEncode } from "@jsquash/png/encode";
import { localImageToBase64 } from "../../src/llm/image-io";
import { DEFAULT_MAX_LONG_EDGE, imageDimensionsFromHeader } from "../../src/llm/image-resize";

let dir: string;
const loader = {
  async load(block: { path: string }) {
    const file = Bun.file(block.path);
    return (await file.exists()) ? file.arrayBuffer() : null;
  },
};

beforeAll(async () => {
  const mod = await WebAssembly.compile(await Bun.file(pngWasm).arrayBuffer());
  await initPngDecode(mod);
  await initPngEncode(mod);
  dir = await mkdtemp(join(tmpdir(), "image-io-test-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function solidPng(width: number, height: number): Promise<ArrayBuffer> {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  return encodePng({ data, width, height } as unknown as ImageData);
}

test("materializing an oversized stored image downscales it to the long-edge cap", async () => {
  const path = join(dir, "large.png");
  await Bun.write(path, await solidPng(3000, 2000));

  const block = await localImageToBase64({ type: "local_image", path, mediaType: "image/png" }, { loader });
  expect(block).not.toBeNull();

  const bytes = new Uint8Array(Buffer.from(block!.source.data, "base64"));
  const dims = imageDimensionsFromHeader(bytes, "image/png");
  expect(dims).not.toBeNull();
  expect(Math.max(dims!.width, dims!.height)).toBe(DEFAULT_MAX_LONG_EDGE);
});

test("materializing an in-cap image returns its bytes unchanged", async () => {
  const path = join(dir, "small.png");
  const original = await solidPng(100, 80);
  await Bun.write(path, original);

  const block = await localImageToBase64({ type: "local_image", path, mediaType: "image/png" }, { loader });
  expect(block).not.toBeNull();
  expect(Buffer.from(block!.source.data, "base64").equals(Buffer.from(original))).toBe(true);
});
