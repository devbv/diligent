// @summary Bridge an MCP tool definition into a Diligent Tool (schema passthrough, approval, result map)

import { createHash } from "node:crypto";
import type { Tool, ToolResult } from "@diligent/core/tool/types";
import type { ImageBlock } from "@diligent/protocol";
import { SUPPORTED_IMAGE_MEDIA_TYPES } from "@diligent/protocol";
import { z } from "zod";
import type { RuntimeToolHost } from "../capabilities";
import { requestToolApproval } from "../capabilities";
import type { McpConnectionManager } from "./client";
import type { McpToolDef } from "./types";

/** Provider function-name limit (OpenAI caps at 64). */
const MAX_TOOL_NAME_BYTES = 64;

function sanitize(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Build a collision-safe, namespaced tool name `mcp__<server>__<tool>`.
 * Truncates and appends a short stable hash when the sanitized name exceeds 64 bytes (C4).
 */
export function mcpToolName(serverName: string, toolName: string): string {
  const full = `mcp__${sanitize(serverName)}__${sanitize(toolName)}`;
  if (Buffer.byteLength(full, "utf8") <= MAX_TOOL_NAME_BYTES) return full;
  const hash = createHash("sha256").update(`${serverName}\u0000${toolName}`).digest("hex").slice(0, 8);
  const budget = MAX_TOOL_NAME_BYTES - (hash.length + 1);
  return `${full.slice(0, budget)}_${hash}`;
}

function isSupportedMedia(mimeType: string): mimeType is (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number] {
  return (SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(mimeType);
}

export function mcpToolToDiligentTool(args: {
  serverName: string;
  def: McpToolDef;
  manager: McpConnectionManager;
  host?: RuntimeToolHost;
}): Tool {
  const { serverName, def, manager, host } = args;
  const toolName = mcpToolName(serverName, def.name);

  return {
    name: toolName,
    description: def.description ?? `MCP tool "${def.name}" from server "${serverName}"`,
    parameters: z.object({}).passthrough(),
    inputSchema: def.inputSchema,
    supportParallel: def.readOnly === true,
    parseArgs: (raw) => (raw ?? {}) as Record<string, unknown>,
    async execute(rawArgs, ctx): Promise<ToolResult> {
      const decision = await requestToolApproval(host, {
        permission: "execute",
        toolName,
        description: `Call MCP tool "${def.name}" on server "${serverName}"`,
        details: { server: serverName, tool: def.name, args: rawArgs },
      });
      if (decision === "reject") {
        return { output: "Tool call rejected by user." };
      }

      const result = await manager.call(serverName, def.name, rawArgs, ctx.signal);
      const outputImages: ImageBlock[] = result.images
        .filter((image) => isSupportedMedia(image.mimeType))
        .map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mimeType as (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number],
            data: image.data,
          },
        }));

      const output = result.text || (result.isError ? "MCP tool returned an error." : "(no output)");
      return {
        output,
        ...(outputImages.length > 0 ? { outputImages } : {}),
        metadata: { mcpServer: serverName, mcpTool: def.name, isError: result.isError },
      };
    },
  };
}
