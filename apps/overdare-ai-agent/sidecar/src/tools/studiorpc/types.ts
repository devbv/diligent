// @summary Local Studio RPC tool type aliases for product-bundled providers.

import type {
  Tool as CoreTool,
  ToolContext as CoreToolContext,
  ToolRenderPayloadLike,
  ToolResult,
} from "@diligent/core/tool-contract";
import type { RuntimeToolHost } from "@diligent/runtime";

export type ToolContext = CoreToolContext & {
  approve: NonNullable<RuntimeToolHost["approve"]>;
};

export type Tool = Omit<CoreTool, "execute"> & {
  execute: (args: never, ctx: ToolContext) => Promise<ToolResult>;
};

export type { ToolResult };
export type ToolRenderPayload = ToolRenderPayloadLike;
