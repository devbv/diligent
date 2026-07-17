// @summary Reads persisted local image blocks into provider-ready base64 image blocks with validation
import type { ContentBlock, ImageBlock, LocalImageBlock } from "../types";
import { downscaleImageIfNeeded } from "./image-resize";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface LocalImageLoader {
  load(block: LocalImageBlock): Promise<ArrayBuffer | null>;
}

function fileNameFromPath(path: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  return segments[segments.length - 1] ?? path;
}

export async function localImageToBase64(
  block: LocalImageBlock,
  options: { loader: LocalImageLoader },
): Promise<ImageBlock | null> {
  const bytes = await options.loader.load(block);
  if (!bytes) return null;
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Attached image exceeds 10 MB limit: ${fileNameFromPath(block.path)}`);
  }

  // Guards images persisted before upload-time downscaling existed: local_image blocks are
  // re-materialized on EVERY request, so an oversized stored file otherwise re-inflates each turn
  // and can breach Anthropic's 32 MB request cap long before token-based compaction triggers.
  // Header fast-path makes this a no-op for images already within the cap.
  let downscaled = { bytes, mediaType: block.mediaType };
  try {
    downscaled = await downscaleImageIfNeeded(bytes, block.mediaType);
  } catch {
    // Re-encode failure must not fail the whole request — send the original.
  }

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: downscaled.mediaType,
      data: Buffer.from(downscaled.bytes).toString("base64"),
    },
  };
}

export async function materializeUserContentBlocks(
  blocks: ContentBlock[],
  options: { loader?: LocalImageLoader },
): Promise<ContentBlock[]> {
  const result: ContentBlock[] = [];

  for (const block of blocks) {
    if (block.type === "local_image") {
      const imageBlock = options.loader ? await localImageToBase64(block, { loader: options.loader }) : null;
      if (imageBlock) result.push(imageBlock);
    } else {
      result.push(block);
    }
  }

  return result;
}
