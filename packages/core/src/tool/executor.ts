// @summary Executes tool calls with parameter validation and auto-truncation
import type { ZodIssue } from "zod";
import type { ToolCallBlock } from "../types";
import {
  MAX_OUTPUT_BYTES,
  shouldTruncate,
  TRUNCATION_WARNING,
  truncateHead,
  truncateHeadTail,
  truncateTail,
} from "./truncation";
import type { ToolContext, ToolRegistry, ToolResult } from "./types";

/** Filesystem adapter for persisting a full tool output when core truncates the returned payload. */
export interface ToolOutputFileStore {
  save(output: string): Promise<string>;
}

export interface ExecuteToolOptions {
  outputStore?: ToolOutputFileStore;
}

export async function executeTool(
  registry: ToolRegistry,
  toolCall: ToolCallBlock,
  ctx: ToolContext,
  options?: ExecuteToolOptions,
): Promise<ToolResult> {
  const tool = registry.get(toolCall.name);
  if (!tool) {
    return { output: `Error: Unknown tool "${toolCall.name}"`, metadata: { error: true } };
  }

  let args: unknown;
  if (tool.parseArgs) {
    try {
      args = tool.parseArgs(toolCall.input);
    } catch (err) {
      return {
        output: `Error: Invalid arguments for "${toolCall.name}":\n${err instanceof Error ? err.message : String(err)}`,
        metadata: { error: true },
      };
    }
  } else {
    const parsed = tool.parameters.safeParse(toolCall.input);
    if (!parsed.success) {
      return {
        output: `Error: Invalid arguments for "${toolCall.name}":\n${parsed.error.issues.map((i: ZodIssue) => `  [${i.path.join(".")}] ${i.message}`).join("\n")}`,
        metadata: { error: true },
      };
    }
    args = parsed.data;
  }

  let result: ToolResult;
  try {
    result = await tool.execute(args, ctx);
    if (result.abortRequested) ctx.abort();
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return {
      output: `Error: Tool "${toolCall.name}" threw an unexpected error: ${message}`,
      metadata: { error: true },
    };
  }

  // D025: Auto-truncation safety net (honors a per-result byte cap when the tool sets one).
  const maxBytes = result.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  if (shouldTruncate(result.output, maxBytes)) {
    const direction = result.truncateDirection ?? "tail";
    const truncated =
      direction === "head"
        ? truncateHead(result.output, maxBytes)
        : direction === "head_tail"
          ? truncateHeadTail(result.output, maxBytes)
          : truncateTail(result.output, maxBytes);

    let savedPath: string | undefined;
    try {
      savedPath = await options?.outputStore?.save(result.output);
    } catch {
      // Full-output persistence is optional diagnostics. A usable truncated result already exists.
    }

    return {
      ...result,
      output:
        truncated.output +
        TRUNCATION_WARNING +
        (savedPath ? " Full output saved to disk." : "") +
        `\n(truncated from ${truncated.originalBytes} bytes.${savedPath ? ` Full output at: ${savedPath}` : ""})`,
      metadata: {
        ...result.metadata,
        truncated: true,
        truncatedFrom: { bytes: truncated.originalBytes },
        ...(savedPath ? { fullOutputPath: savedPath } : {}),
      },
      truncateDirection: direction,
    };
  }

  return result;
}
