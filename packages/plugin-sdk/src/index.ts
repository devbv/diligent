// @summary Exports the public plugin-facing SDK types for external tool packages.
import type { ApprovalRequest, ApprovalResponse, UserInputRequest, UserInputResponse } from "@diligent/protocol";
import type { z } from "zod";

export type { ApprovalRequest, ApprovalResponse, UserInputRequest, UserInputResponse };

export interface ToolRenderPayload {
  inputSummary?: string;
  outputSummary?: string;
  blocks: Array<Record<string, unknown>>;
}

export interface ToolContext {
  toolCallId: string;
  signal: AbortSignal;
  abort: () => void;
  approve: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  ask: (request: UserInputRequest) => Promise<UserInputResponse | null>;
  onUpdate?: (partialResult: string) => void;
}

export interface ToolResult {
  output: string;
  render?: ToolRenderPayload;
  metadata?: Record<string, unknown>;
}

/**
 * Input passed to plugin lifecycle hook handlers.
 * Contains session context and event-specific fields.
 */
export interface PluginHookInput {
  hook_event_name: string;
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  user_id?: string;
  /**
   * Set to `true` when the current turn was triggered by a Stop hook that returned `blocked: true`.
   * Plugins should check this field and avoid blocking again to prevent infinite re-run loops.
   * Only present on Stop hook events; absent on UserPromptSubmit and other events.
   */
  stop_hook_active?: boolean;
  /** Token usage for the completed turn. Only present on Stop hook events. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  /** Model used for the completed turn. Only present on Stop hook events. */
  model?: string;
  /** Provider used for the completed turn. Only present on Stop hook events. */
  provider?: string;
  /** Provider subscription plan for the completed turn when available. Only present on Stop hook events. */
  provider_plan_type?: string;
  /** Effort level used for the completed turn. Only present on Stop hook events. */
  effort?: string;
  /** Last assistant message text from the completed turn. Only present on Stop hook events. */
  last_assistant_message?: string;
  [key: string]: unknown;
}

/**
 * Return value from a plugin lifecycle hook handler.
 * Omitting `blocked` (or returning `{}`) allows the operation to proceed.
 */
export interface PluginHookResult {
  /** Return true to block the operation. */
  blocked?: boolean;
  /** Reason shown to the user when blocked. */
  reason?: string;
  /** Text prepended to the conversation context (UserPromptSubmit only). */
  additionalContext?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: generic default requires any for unparameterized Tool references
export interface Tool<TParams extends z.ZodType = any> {
  name: string;
  description: string;
  parameters: TParams;
  execute: (args: z.infer<TParams>, ctx: ToolContext) => Promise<ToolResult>;
  supportParallel?: boolean;
  /** Custom arg parser. When provided, executor uses this instead of parameters.safeParse(). */
  parseArgs?: (raw: unknown) => z.infer<TParams>;
}
