import type { ToolCallBlock } from "../types";
import { persistFullOutput, shouldTruncate, truncateHead, truncateTail } from "./truncation";
import type { ToolContext, ToolRegistry, ToolResult } from "./types";

export async function executeTool(
  registry: ToolRegistry,
  toolCall: ToolCallBlock,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(toolCall.name);
  if (!tool) {
    return { output: `Error: Unknown tool "${toolCall.name}"`, metadata: { error: true } };
  }

  const parsed = tool.parameters.safeParse(toolCall.input);
  if (!parsed.success) {
    return {
      output: `Error: Invalid arguments for "${toolCall.name}":\n${parsed.error.format()._errors.join("\n")}`,
      metadata: { error: true },
    };
  }

  const result = await tool.execute(parsed.data, ctx);

  // D025: Auto-truncation safety net
  if (shouldTruncate(result.output)) {
    const direction = result.truncateDirection ?? "tail";
    const truncated = direction === "head" ? truncateHead(result.output) : truncateTail(result.output);

    const savedPath = await persistFullOutput(result.output);

    return {
      output:
        truncated.output +
        `\n\n... (truncated from ${truncated.originalLines} lines / ${truncated.originalBytes} bytes. Full output at: ${savedPath})`,
      metadata: {
        ...result.metadata,
        truncated: true,
        truncatedFrom: { bytes: truncated.originalBytes, lines: truncated.originalLines },
        fullOutputPath: savedPath,
      },
      truncateDirection: direction,
    };
  }

  return result;
}
