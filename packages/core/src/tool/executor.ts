import type { ToolCallBlock } from "../types";
import type { ToolRegistry, ToolContext, ToolResult } from "./types";

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

  return tool.execute(parsed.data, ctx);
}
