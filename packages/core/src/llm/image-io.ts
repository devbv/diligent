// @summary Reads persisted local image blocks into provider-ready base64 image blocks with validation
import type { ContentBlock, ImageBlock, LocalImageBlock } from "../types";
import { downscaleImageIfNeeded } from "./image-resize";
import { resolvePersistedLocalImagePath } from "./local-image-paths";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function fileNameFromPath(path: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  return segments[segments.length - 1] ?? path;
}

export async function localImageToBase64(
  block: LocalImageBlock,
  options?: { cwd?: string },
): Promise<ImageBlock | null> {
  const resolvedPath = resolvePersistedLocalImagePath(block.path, options?.cwd);
  const file = Bun.file(resolvedPath);
  if (!(await file.exists())) {
    return null;
  }

  const size = file.size;
  if (typeof size === "number" && size > MAX_IMAGE_BYTES) {
    throw new Error(`Attached image exceeds 10 MB limit: ${fileNameFromPath(resolvedPath)}`);
  }

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Attached image exceeds 10 MB limit: ${fileNameFromPath(resolvedPath)}`);
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
  options?: { cwd?: string },
): Promise<ContentBlock[]> {
  const result: ContentBlock[] = [];

  for (const block of blocks) {
    if (block.type === "local_image") {
      const imageBlock = await localImageToBase64(block, options);
      if (imageBlock) result.push(imageBlock);
    } else {
      result.push(block);
    }
  }

  return result;
}
