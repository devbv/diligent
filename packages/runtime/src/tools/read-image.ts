// @summary Read an image file from disk and return it as base64 image content for LLM vision

import { lstat, realpath } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Tool, ToolContext, ToolResult } from "@diligent/core/tool/types";
import type { ImageBlock } from "@diligent/core/types";
import { z } from "zod";
import { isAbsolute, stripExtendedLengthPrefix } from "../util/path";
import { createTextRenderPayload, summarizeRenderText } from "./render-payload";

const ReadImageParams = z.object({
  file_path: z.string().describe("Absolute path to the image file to read"),
});

// Anthropic's per-image base64 limit is 5 MB; match it to fail fast locally
// rather than at the provider on the next turn.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const EXTENSION_TO_MEDIA_TYPE: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function mediaTypeFromExtension(filePath: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  const name = basename(filePath);
  // Dotfiles like "/foo/.png" — basename starts with '.' and has no real extension.
  if (name.startsWith(".") && name.lastIndexOf(".") === 0) return null;
  const ext = extname(name).toLowerCase();
  return EXTENSION_TO_MEDIA_TYPE[ext] ?? null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function errorResult(message: string): ToolResult {
  return {
    output: message,
    render: createTextRenderPayload(undefined, message, true),
    metadata: { error: true },
  };
}

// Sniff magic bytes and return the canonical media type, or null if unrecognized.
function detectMediaTypeFromMagicBytes(
  bytes: Uint8Array,
): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  // GIF: "GIF87a" or "GIF89a"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  // WEBP: "RIFF....WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function createReadImageTool(): Tool<typeof ReadImageParams> {
  return {
    name: "read_image",
    description:
      "Read an image file (PNG, JPEG, GIF, WebP) from disk so you can see it. " +
      "Use this — not the `read` tool — for any image path. " +
      "Do not describe an image's contents without calling this first. " +
      "Requires an absolute path.",
    parameters: ReadImageParams,
    supportParallel: true,
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      if (ctx.signal.aborted) return errorResult("Aborted");

      const file_path = stripExtendedLengthPrefix(args.file_path);
      if (!isAbsolute(file_path)) {
        return errorResult(`Error: file_path must be absolute: ${args.file_path}`);
      }

      const declaredMediaType = mediaTypeFromExtension(file_path);
      if (!declaredMediaType) {
        return errorResult(
          `Error: Unsupported image type. read_image accepts .png, .jpg/.jpeg, .gif, .webp. Got: ${file_path}`,
        );
      }

      // Reject symlinks to prevent traversal/exfil: a foo.png symlink could
      // point at ~/.ssh/id_rsa or other sensitive files.
      let stat: Awaited<ReturnType<typeof lstat>>;
      try {
        stat = await lstat(file_path);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") return errorResult(`Error: File not found: ${file_path}`);
        return errorResult(`Error reading image: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (stat.isSymbolicLink()) {
        // Resolve and re-validate the target's extension stays in the allowed set.
        let resolvedTarget: string;
        try {
          resolvedTarget = await realpath(file_path);
        } catch (err) {
          return errorResult(`Error: Symlink target unreadable: ${err instanceof Error ? err.message : String(err)}`);
        }
        const targetMediaType = mediaTypeFromExtension(resolvedTarget);
        if (!targetMediaType || targetMediaType !== declaredMediaType) {
          return errorResult(
            `Error: Symlink ${basename(file_path)} resolves to a non-image or different-type target; refusing for safety.`,
          );
        }
      } else if (!stat.isFile()) {
        return errorResult(`Error: Not a regular file: ${file_path}`);
      }

      if (stat.size > MAX_IMAGE_BYTES) {
        return errorResult(`Error: Image exceeds 5 MB limit (${formatBytes(stat.size)}): ${basename(file_path)}`);
      }
      if (stat.size === 0) {
        return errorResult(`Error: Image is empty: ${basename(file_path)}`);
      }

      if (ctx.signal.aborted) return errorResult("Aborted");

      let bytes: ArrayBuffer;
      try {
        bytes = await Bun.file(file_path).arrayBuffer();
      } catch (err) {
        return errorResult(`Error reading image: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (ctx.signal.aborted) return errorResult("Aborted");

      // Race guard: file may have grown between lstat and read.
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return errorResult(
          `Error: Image exceeds 5 MB limit (${formatBytes(bytes.byteLength)}): ${basename(file_path)}`,
        );
      }

      // Verify magic bytes match the declared media type. An extension lie
      // (e.g. .jpg containing PNG bytes) would otherwise reach Anthropic and
      // surface as an opaque 400.
      const actualMediaType = detectMediaTypeFromMagicBytes(new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength)));
      if (!actualMediaType) {
        return errorResult(
          `Error: ${basename(file_path)} does not have a recognized image header (PNG/JPEG/GIF/WebP).`,
        );
      }
      if (actualMediaType !== declaredMediaType) {
        return errorResult(
          `Error: File extension says ${declaredMediaType} but content is ${actualMediaType}: ${basename(file_path)}`,
        );
      }

      const imageBlock: ImageBlock = {
        type: "image",
        source: {
          type: "base64",
          media_type: declaredMediaType,
          data: Buffer.from(bytes).toString("base64"),
        },
      };

      const summary = `Loaded image ${basename(file_path)} (${formatBytes(bytes.byteLength)}, ${declaredMediaType})`;

      return {
        output: summary,
        outputImages: [imageBlock],
        render: {
          inputSummary: summarizeRenderText(file_path),
          outputSummary: summary,
          blocks: [{ type: "text", title: file_path, text: summary }],
        },
      };
    },
  };
}
