// @summary Bridge an MCP tool definition into a Diligent Tool (schema passthrough, approval, result map)

import { createHash } from "node:crypto";
import type { Tool, ToolContext, ToolResult } from "@diligent/core/tool/types";
import { createLogger } from "@diligent/logging";
import type { ImageBlock } from "@diligent/protocol";
import { SUPPORTED_IMAGE_MEDIA_TYPES } from "@diligent/protocol";
import { z } from "zod";
import type { RuntimeToolHost } from "../capabilities";
import { requestToolApproval } from "../capabilities";
import type { McpConnectionManager } from "./client";
import type { McpCallResult, McpOutputLimit, McpToolDef } from "./types";

const logger = createLogger({ scope: "runtime.mcp.tool" });

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

/** Apply a per-tool character override (`anthropic/maxResultSizeChars`) on top of the default limit. */
export function resolveMcpOutputLimit(
  maxResultSizeChars: number | undefined,
  defaultLimit: McpOutputLimit,
): McpOutputLimit {
  return maxResultSizeChars ? { maxBytes: maxResultSizeChars, warnBytes: defaultLimit.warnBytes } : defaultLimit;
}

/**
 * Map a normalized MCP call result into a Diligent `ToolResult` (text + supported images +
 * metadata). When `outputLimit` is provided, sets the per-result byte cap the executor enforces and
 * logs a console warning for oversized output (mirrors Claude Code's MCP output-size handling).
 */
export function mapMcpCallResult(
  result: McpCallResult,
  serverName: string,
  toolName: string,
  outputLimit?: McpOutputLimit,
): ToolResult {
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
  if (outputLimit) {
    const bytes = Buffer.byteLength(output, "utf8");
    if (bytes > outputLimit.warnBytes) {
      logger.warn("large_tool_output", {
        message:
          `[mcp] tool "${toolName}" on server "${serverName}" returned ${bytes} bytes` +
          (bytes > outputLimit.maxBytes ? ` (exceeds ${outputLimit.maxBytes}-byte cap, will be truncated)` : ""),
        fields: { server: serverName, tool: toolName, bytes, maxBytes: outputLimit.maxBytes },
      });
    }
  }
  return {
    output,
    ...(outputImages.length > 0 ? { outputImages } : {}),
    ...(outputLimit ? { maxOutputBytes: outputLimit.maxBytes } : {}),
    metadata: { mcpServer: serverName, mcpTool: toolName, isError: result.isError },
  };
}

/**
 * Request approval, then call an MCP tool via the manager and normalize the result. Shared by both
 * the eager per-tool bridge and the lazy `mcp_run_tool` proxy so approval/result handling stays
 * identical. `approvalToolName` is the Diligent-facing tool name shown in the approval prompt.
 */
export async function callMcpToolWithApproval(args: {
  manager: McpConnectionManager;
  host: RuntimeToolHost | undefined;
  serverName: string;
  toolName: string;
  approvalToolName: string;
  rawArgs: unknown;
  ctx: ToolContext;
  outputLimit?: McpOutputLimit;
}): Promise<ToolResult> {
  const { manager, host, serverName, toolName, approvalToolName, rawArgs, ctx, outputLimit } = args;
  const decision = await requestToolApproval(host, {
    permission: "execute",
    toolName: approvalToolName,
    description: `Call MCP tool "${toolName}" on server "${serverName}"`,
    details: { server: serverName, tool: toolName, args: rawArgs },
  });
  if (decision === "reject") {
    return { output: "Tool call rejected by user." };
  }

  const result = await manager.call(serverName, toolName, rawArgs, ctx.signal);
  return mapMcpCallResult(result, serverName, toolName, outputLimit);
}

export function mcpToolToDiligentTool(args: {
  serverName: string;
  def: McpToolDef;
  manager: McpConnectionManager;
  host?: RuntimeToolHost;
  outputLimit?: McpOutputLimit;
}): Tool {
  const { serverName, def, manager, host, outputLimit } = args;
  const toolName = mcpToolName(serverName, def.name);

  return {
    name: toolName,
    description: def.description ?? `MCP tool "${def.name}" from server "${serverName}"`,
    parameters: z.object({}).passthrough(),
    inputSchema: def.inputSchema,
    supportParallel: def.readOnly === true,
    parseArgs: (raw) => (raw ?? {}) as Record<string, unknown>,
    async execute(rawArgs, ctx): Promise<ToolResult> {
      return callMcpToolWithApproval({
        manager,
        host,
        serverName,
        toolName: def.name,
        approvalToolName: toolName,
        rawArgs,
        ctx,
        outputLimit,
      });
    },
  };
}
