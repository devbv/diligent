import { z } from "zod";

// D013: Tool definition
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Tool<TParams extends z.ZodType = any> {
  name: string;
  description: string;
  parameters: TParams;
  execute: (args: z.infer<TParams>, ctx: ToolContext) => Promise<ToolResult>;
}

// D016: Tool context with approval placeholder
export interface ToolContext {
  toolCallId: string;
  signal: AbortSignal;
  approve: (request: ApprovalRequest) => Promise<boolean>;
  onUpdate?: (partialResult: string) => void;
}

export interface ApprovalRequest {
  permission: "read" | "write" | "execute";
  description: string;
}

// D020: Tool result
export interface ToolResult {
  output: string;
  metadata?: Record<string, unknown>;
}

// D014: Registry type
export type ToolRegistry = Map<string, Tool>;
