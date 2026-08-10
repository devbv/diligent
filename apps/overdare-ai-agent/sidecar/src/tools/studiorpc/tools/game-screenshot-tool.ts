// @summary Captures an OVERDARE Studio viewport screenshot and returns it as an image the agent can see.

import { downscaleImageIfNeeded } from "@diligent/core/image-contract";
import type { ImageBlock } from "@diligent/protocol";
import * as gameScreenshot from "../methods/game.screenshot";
import { buildGameScreenshotRender } from "../render";
import type { call } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";

// Anthropic's per-image base64 tool_result limit. Other providers get the image via a synthetic
// follow-up user message (see packages/core/src/llm/provider/*), which has looser limits, but staying
// under Anthropic's cap keeps behavior uniform across providers.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mediaTypeFromPath(path: string): "image/png" | "image/jpeg" {
  return /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Screenshot capture is read-only (it never changes level/game state), so unlike the mutating
// generic-loop methods this skips ctx.approve — matching studiorpc_instance_read / script_read /
// snapshot_list, the other read-only bespoke tools carved out of the generic loop for the same reason.
export function createGameScreenshotTool(callRpc: typeof call): Tool {
  return {
    name: "studiorpc_game_screenshot",
    description: gameScreenshot.description,
    parameters: gameScreenshot.params,
    async execute(rawArgs, ctx: ToolContext): Promise<ToolResult> {
      const args = gameScreenshot.params.parse(rawArgs ?? {});
      const normalizedArgs = gameScreenshot.normalizeArgs(args);
      const result = await callRpc(gameScreenshot.method, normalizedArgs);
      const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      const render = buildGameScreenshotRender(result, normalizedArgs, output);
      const metadata = { method: gameScreenshot.method, result };

      const path = isRecord(result) && typeof result.path === "string" ? result.path : undefined;
      if (!path || ctx.signal.aborted) {
        return { output, render, metadata };
      }

      let bytes: ArrayBuffer;
      try {
        bytes = await Bun.file(path).arrayBuffer();
      } catch (error) {
        return {
          output: `${output}\n[Captured, but could not be loaded for viewing: ${
            error instanceof Error ? error.message : String(error)
          }. Don't assume the result looks right — confirm with the user instead.]`,
          render,
          metadata,
        };
      }

      const declaredMediaType = mediaTypeFromPath(path);
      // A resize failure must not drop the capture — fall back to the original bytes. Annotated
      // explicitly because downscaleImageIfNeeded's return type widens to include "image/webp".
      let encoded: { bytes: ArrayBuffer; mediaType: "image/png" | "image/jpeg" | "image/webp" } = {
        bytes,
        mediaType: declaredMediaType,
      };
      try {
        encoded = await downscaleImageIfNeeded(bytes, declaredMediaType);
      } catch {
        // fall through with the original bytes
      }

      if (encoded.bytes.byteLength > MAX_IMAGE_BYTES) {
        return {
          output: `${output}\n[Captured (${formatBytes(
            encoded.bytes.byteLength,
          )}), but too large to attach for viewing. Don't assume the result looks right — confirm with the user instead.]`,
          render,
          metadata,
        };
      }

      const imageBlock: ImageBlock = {
        type: "image",
        source: {
          type: "base64",
          media_type: encoded.mediaType,
          data: Buffer.from(encoded.bytes).toString("base64"),
        },
      };

      return { output, outputImages: [imageBlock], render, metadata };
    },
  };
}
