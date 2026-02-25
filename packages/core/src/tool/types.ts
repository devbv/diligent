import type { z } from "zod";

// D013: Tool definition
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Tool<TParams extends z.ZodType = any> {
  name: string;
  description: string;
  parameters: TParams;
  execute: (args: z.infer<TParams>, ctx: ToolContext) => Promise<ToolResult>;
}

// D086: Approval response — "once" (proceed once), "always" (remember), "reject" (deny)
export type ApprovalResponse = "once" | "always" | "reject";

// D016: Tool context — D086: approve returns ApprovalResponse
export interface ToolContext {
  toolCallId: string;
  signal: AbortSignal;
  approve: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  onUpdate?: (partialResult: string) => void;
}

// D086: Expanded approval request with toolName + details for pattern matching
export interface ApprovalRequest {
  permission: "read" | "write" | "execute";
  toolName: string;
  description: string;
  details?: Record<string, unknown>;
}

// D020: Tool result
export interface ToolResult {
  output: string;
  metadata?: Record<string, unknown>;
  truncateDirection?: "head" | "tail"; // D025: hint for auto-truncation. Default: "tail"
}

// D014: Registry type
export type ToolRegistry = Map<string, Tool>;
