// @summary Downscale oversized images before base64 encoding. Vision token cost is driven by pixel
// resolution (≈ width×height/750 for Anthropic), NOT by base64/byte size — base64 is just transport,
// decoded server-side before the vision encoder runs. Capping the long edge keeps token cost bounded
// and uniform across providers (Anthropic auto-resizes; OpenAI/Gemini do not).

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

  let image: ImageDataLike;
  try {
    image = await decodeImage(bytes, mediaType);
  } catch {
    return bytes;
  }

  const longEdge = Math.max(image.width, image.height);
  if (longEdge <= maxLongEdge) return bytes;

  const scale = maxLongEdge / longEdge;
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);

  await ensureResize();
  const resized = await resize(image as unknown as ImageData, { width, height });
  return await encodeImage(resized, mediaType);
}
