// @summary Downscale oversized images before base64 encoding. Vision token cost is driven by pixel
// resolution (≈ width×height/750 for Anthropic), NOT by base64/byte size — base64 is just transport,
// decoded server-side before the vision encoder runs. Capping the long edge keeps token cost bounded
// and uniform across providers (Anthropic auto-resizes; OpenAI/Gemini do not).

import type { Tool } from "@diligent/core/tool/types";
import type { ImageBlock } from "@diligent/core/types";

// `with { type: "file" }` makes bun embed the wasm into the compiled single-file binary; the import
// resolves to a path we read at runtime and hand to each codec's init — bypassing the broken
// fetch/streaming-instantiate path that fails under `bun build --compile`. This is a bun-only import
// form with no portable .wasm types (and an ambient declaration here would not reach the dependent
// packages that compile these files), so each is suppressed individually.
// @ts-expect-error -- file import yields a path string at runtime
import jpegDecWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm" with { type: "file" };
// @ts-expect-error -- file import yields a path string at runtime
import jpegEncWasm from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm" with { type: "file" };
import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode";
import encodeJpeg, { init as initJpegEncode } from "@jsquash/jpeg/encode";
// @ts-expect-error -- file import yields a path string at runtime
import pngWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm" with { type: "file" };
import decodePng, { init as initPngDecode } from "@jsquash/png/decode";
import encodePng, { init as initPngEncode } from "@jsquash/png/encode";
import resize, { initResize } from "@jsquash/resize";
// @ts-expect-error -- file import yields a path string at runtime
import resizeWasm from "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm" with { type: "file" };
// @ts-expect-error -- file import yields a path string at runtime
import webpDecWasm from "@jsquash/webp/codec/dec/webp_dec.wasm" with { type: "file" };
// @ts-expect-error -- file import yields a path string at runtime
import webpEncWasm from "@jsquash/webp/codec/enc/webp_enc.wasm" with { type: "file" };
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode";
import encodeWebp, { init as initWebpEncode } from "@jsquash/webp/encode";

export type ResizableMediaType = "image/png" | "image/jpeg" | "image/webp";

// Anthropic processes images at no token penalty up to 1568px on the long edge (~1.15 MP). Matching
// that threshold means we send the smallest image that costs the least without sacrificing detail
// the model could use.
export const DEFAULT_MAX_LONG_EDGE = 1568;

// Decoding allocates width×height×4 bytes of RGBA. Refuse to decode past this ceiling so a
// pathologically large image (e.g. a 30 MB PNG that expands to gigabytes) cannot OOM the runtime;
// such images pass through untouched and are bounded by the caller's transport-size cap instead.
const MAX_DECODE_PIXELS = 64 * 1024 * 1024; // 64 MP ≈ 256 MB RGBA

// mozjpeg / webp are lossy; 80 keeps screenshots/photos legible to the vision model while shrinking
// payload well below the source. PNG re-encode is lossless so it takes no quality option.
const JPEG_QUALITY = 80;
const WEBP_QUALITY = 80;

type ImageDataLike = { data: Uint8ClampedArray; width: number; height: number };

async function wasmBytes(path: string): Promise<ArrayBuffer> {
  return await Bun.file(path).arrayBuffer();
}

// Each codec inits exactly once; cache the promise so concurrent read_image calls share one init.
let pngReady: Promise<void> | null = null;
let jpegReady: Promise<void> | null = null;
let webpReady: Promise<void> | null = null;
let resizeReady: Promise<void> | null = null;

async function ensurePng(): Promise<void> {
  pngReady ??= (async () => {
    // png decode + encode share one wasm-bindgen module; init takes a compiled WebAssembly.Module.
    const mod = await WebAssembly.compile(await wasmBytes(pngWasm));
    await initPngDecode(mod);
    await initPngEncode(mod);
  })();
  await pngReady;
}

// mozjpeg/webp are Emscripten codecs that print to stdout/stderr on malformed input (e.g. "JPEG
// datastream contains no image"). We already surface decode failures as a clean passthrough, so
// silence the codec's own logging to keep tool output pristine.
const SILENT_EMSCRIPTEN = { print: () => {}, printErr: () => {} };

async function ensureJpeg(): Promise<void> {
  // mozjpeg is an Emscripten codec — init takes module options with the raw wasm bytes (`wasmBinary`),
  // not a WebAssembly.Module.
  jpegReady ??= (async () => {
    await initJpegDecode({ ...SILENT_EMSCRIPTEN, wasmBinary: await wasmBytes(jpegDecWasm) });
    await initJpegEncode({ ...SILENT_EMSCRIPTEN, wasmBinary: await wasmBytes(jpegEncWasm) });
  })();
  await jpegReady;
}

async function ensureWebp(): Promise<void> {
  webpReady ??= (async () => {
    await initWebpDecode({ ...SILENT_EMSCRIPTEN, wasmBinary: await wasmBytes(webpDecWasm) });
    await initWebpEncode({ ...SILENT_EMSCRIPTEN, wasmBinary: await wasmBytes(webpEncWasm) });
  })();
  await webpReady;
}

async function ensureResize(): Promise<void> {
  resizeReady ??= (async () => {
    await initResize(await WebAssembly.compile(await wasmBytes(resizeWasm)));
  })();
  await resizeReady;
}

async function decodeImage(bytes: ArrayBuffer, mediaType: ResizableMediaType): Promise<ImageDataLike> {
  switch (mediaType) {
    case "image/png":
      await ensurePng();
      return await decodePng(bytes);
    case "image/jpeg":
      await ensureJpeg();
      return await decodeJpeg(bytes);
    case "image/webp":
      await ensureWebp();
      return await decodeWebp(bytes);
  }
}

async function encodeImage(image: ImageDataLike, mediaType: ResizableMediaType): Promise<ArrayBuffer> {
  // jsquash types encode inputs as the DOM `ImageData` (with `colorSpace`); our structural shape is
  // accepted at runtime, so bridge the nominal mismatch here.
  const data = image as unknown as ImageData;
  switch (mediaType) {
    case "image/png":
      await ensurePng();
      return await encodePng(data);
    case "image/jpeg":
      await ensureJpeg();
      return await encodeJpeg(data, { quality: JPEG_QUALITY });
    case "image/webp":
      await ensureWebp();
      return await encodeWebp(data, { quality: WEBP_QUALITY });
  }
}

function isResizable(mediaType: string): mediaType is ResizableMediaType {
  return mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/webp";
}

/**
 * Read pixel dimensions straight from the image header (PNG/JPEG/WebP) without decoding pixels.
 * This lets `downscaleImageIfNeeded` skip the multi-MB full decode for images already within the
 * cap, and refuse pathologically large images before allocating their RGBA bitmap. Returns null on
 * an unrecognized or truncated header — callers then fall back to decoding.
 */
export function imageDimensionsFromHeader(
  bytes: Uint8Array,
  mediaType: ResizableMediaType,
): { width: number; height: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (mediaType === "image/png") {
    // 8-byte signature + IHDR length/type, then width@16 and height@20 (big-endian).
    if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return { width: dv.getUint32(16), height: dv.getUint32(20) };
    }
    return null;
  }

  if (mediaType === "image/jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let off = 2;
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = bytes[off + 1];
      // Start-Of-Frame markers carry dimensions: height@+5, width@+7 (big-endian). Skip the
      // non-SOF markers in the 0xC0-0xCF range (C4 = Huffman, C8 = JPG ext, CC = arithmetic).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: dv.getUint16(off + 7), height: dv.getUint16(off + 5) };
      }
      const len = dv.getUint16(off + 2);
      if (len < 2) return null;
      off += 2 + len;
    }
    return null;
  }

  // image/webp: "RIFF"…"WEBP" then a VP8 / VP8L / VP8X chunk.
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const fmt = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (fmt === "VP8 ") {
      return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    }
    if (fmt === "VP8L") {
      const b0 = bytes[21];
      const b1 = bytes[22];
      const b2 = bytes[23];
      const b3 = bytes[24];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    if (fmt === "VP8X") {
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
    }
  }
  return null;
}

/**
 * Return image bytes whose long edge does not exceed `maxLongEdge`, re-encoding in the same format.
 * Returns the ORIGINAL bytes unchanged when no downscale is warranted:
 *   - format has no jsquash codec (e.g. GIF) — also preserves animation
 *   - bytes the codec cannot decode — let the provider deal with the original
 *   - already within the cap — avoid a needless (lossy, for JPEG/WebP) re-encode
 */
export async function downscaleImageIfNeeded(
  bytes: ArrayBuffer,
  mediaType: string,
  maxLongEdge: number = DEFAULT_MAX_LONG_EDGE,
): Promise<ArrayBuffer> {
  if (!isResizable(mediaType)) return bytes;

  // Header-only fast path: read dimensions without decoding. In-spec images skip the decode
  // entirely, and images whose pixel count would blow the decode-memory ceiling are passed through
  // untouched rather than risking an OOM. A null result (truncated/odd header) falls back to decode.
  const headerDims = imageDimensionsFromHeader(new Uint8Array(bytes), mediaType);
  if (headerDims) {
    if (Math.max(headerDims.width, headerDims.height) <= maxLongEdge) return bytes;
    if (headerDims.width * headerDims.height > MAX_DECODE_PIXELS) return bytes;
  }

  let image: ImageDataLike;
  try {
    image = await decodeImage(bytes, mediaType);
  } catch {
    return bytes;
  }

  const longEdge = Math.max(image.width, image.height);
  if (longEdge <= maxLongEdge) return bytes;

  const scale = maxLongEdge / longEdge;
  // Clamp to >= 1: an extreme aspect ratio (e.g. 6272×1) would otherwise round the short edge to 0,
  // and the resize codec throws on a zero dimension.
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  await ensureResize();
  const resized = await resize(image as unknown as ImageData, { width, height });
  return await encodeImage(resized, mediaType);
}

/** Downscale a single base64 image block, returning the original block when no resize is warranted. */
async function downscaleImageBlock(image: ImageBlock): Promise<ImageBlock> {
  if (image.source.type !== "base64" || !isResizable(image.source.media_type)) return image;
  const u8 = Buffer.from(image.source.data, "base64");
  const input = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  let output: ArrayBuffer;
  try {
    output = await downscaleImageIfNeeded(input, image.source.media_type);
  } catch {
    return image;
  }
  if (output === input) return image;
  return { ...image, source: { ...image.source, data: Buffer.from(output).toString("base64") } };
}

/**
 * Wrap a tool so any images it returns are downscaled at the runtime tool boundary — the single
 * choke point every tool passes through. This bounds vision-token cost uniformly for ALL image
 * sources (screenshots, MCP image results, pasted images), instead of relying on each image-producing
 * tool to downscale itself. read_image already downscales internally, so for it this is a cheap no-op.
 */
export function withImageDownscaling(tool: Tool): Tool {
  return {
    ...tool,
    async execute(args, ctx) {
      const result = await tool.execute(args, ctx);
      if (!result.outputImages || result.outputImages.length === 0) return result;
      return { ...result, outputImages: await Promise.all(result.outputImages.map(downscaleImageBlock)) };
    },
  };
}
