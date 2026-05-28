// @summary Read an image file from disk and return it as base64 image content for LLM vision

import type { Tool, ToolResult } from "@diligent/core/tool/types";
import type { ImageBlock } from "@diligent/core/types";
import { z } from "zod";
import { isAbsolute, stripExtendedLengthPrefix } from "../util/path";
import { createTextRenderPayload, summarizeRenderText } from "./render-payload";

const ReadImageParams = z.object({
  file_path: z.string().describe("Absolute path to the image file to read"),
});

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function mediaTypeFromExtension(filePath: string): string | null {
  const dotIdx = filePath.lastIndexOf(".");
  if (dotIdx === -1) return null;
  const ext = filePath.slice(dotIdx).toLowerCase();
  return EXTENSION_TO_MEDIA_TYPE[ext] ?? null;
}

function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? filePath;
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

export function createReadImageTool(): Tool<typeof ReadImageParams> {
  return {
    name: "read_image",
    description:
      "Read an image file (such as PNG, JPEG, GIF) from disk so you can see it. " +
      "Use this — not `read` tool — for any image path, whether given by the user or returned by another tool (e.g. screenshot tool). " +
      "Do not describe an image's contents without calling this first. " +
      "Requires an absolute path.",
    parameters: ReadImageParams,
    supportParallel: true,
    async execute(args): Promise<ToolResult> {
      const file_path = stripExtendedLengthPrefix(args.file_path);
      if (!isAbsolute(file_path)) {
        return errorResult(`Error: file_path must be absolute: ${file_path}`);
      }

      const mediaType = mediaTypeFromExtension(file_path);
      if (!mediaType) {
        return errorResult(
          `Error: Unsupported image type. read_image accepts .png, .jpg/.jpeg, .gif, .webp. Got: ${file_path}`,
        );
      }

      const file = Bun.file(file_path);
      if (!(await file.exists())) {
        return errorResult(`Error: File not found: ${file_path}`);
      }

      const size = file.size;
      if (typeof size === "number" && size > MAX_IMAGE_BYTES) {
        return errorResult(`Error: Image exceeds 10 MB limit (${formatBytes(size)}): ${fileNameFromPath(file_path)}`);
      }

      let bytes: ArrayBuffer;
      try {
        bytes = await file.arrayBuffer();
      } catch (err) {
        return errorResult(`Error reading image: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return errorResult(
          `Error: Image exceeds 10 MB limit (${formatBytes(bytes.byteLength)}): ${fileNameFromPath(file_path)}`,
        );
      }

      const imageBlock: ImageBlock = {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: Buffer.from(bytes).toString("base64"),
        },
      };

      const summary = `Loaded image ${fileNameFromPath(file_path)} (${formatBytes(bytes.byteLength)}, ${mediaType})`;

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
