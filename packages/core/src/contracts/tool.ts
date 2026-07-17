// @summary Public tool definition, registry, execution, and truncation-policy boundary

export type { ExecuteToolOptions, ToolOutputFileStore } from "../tool/executor";
export { executeTool } from "../tool/executor";
export { ToolRegistryBuilder } from "../tool/registry";
export type { TruncationResult } from "../tool/truncation";
export {
  MAX_OUTPUT_BYTES,
  shouldTruncate,
  TRUNCATION_WARNING,
  truncateHead,
  truncateHeadTail,
  truncateTail,
} from "../tool/truncation";
export type { Tool, ToolContext, ToolRegistry, ToolResult } from "../tool/types";
export type { ToolRenderPayloadLike } from "../types";
