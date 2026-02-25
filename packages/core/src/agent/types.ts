import type { Model, StreamFunction } from "../provider/types";
import type { Tool } from "../tool/types";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "../types";

export type MessageDelta = { type: "text_delta"; delta: string } | { type: "thinking_delta"; delta: string };

// D004: 15 AgentEvent types (all defined, ~7 emitted in Phase 1)
export type AgentEvent =
  // Lifecycle (2) — emitted in Phase 1
  | { type: "agent_start" }
  | { type: "agent_end"; messages: Message[] }
  // Turn (2) — emitted in Phase 1
  | { type: "turn_start"; turnId: string }
  | { type: "turn_end"; turnId: string; message: AssistantMessage; toolResults: ToolResultMessage[] }
  // Message streaming (3) — emitted in Phase 1
  | { type: "message_start"; message: AssistantMessage }
  | { type: "message_delta"; message: AssistantMessage; delta: MessageDelta }
  | { type: "message_end"; message: AssistantMessage }
  // Tool execution (3) — emitted in Phase 1
  | { type: "tool_start"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; partialResult: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; output: string; isError: boolean }
  // Status (1) — emitted in Phase 2
  | { type: "status_change"; status: "idle" | "busy" | "retry"; retry?: { attempt: number; delayMs: number } }
  // Usage (1) — emitted in Phase 2
  | { type: "usage"; usage: Usage; cost: number }
  // Error (1) — emitted in Phase 1
  | { type: "error"; error: Error; fatal: boolean };

// D008: Config for a single agent invocation
export interface AgentLoopConfig {
  model: Model;
  systemPrompt: string;
  tools: Tool[];
  streamFunction: StreamFunction;
  signal?: AbortSignal;
  maxTurns?: number;
  maxRetries?: number; // D010: default 5
  retryBaseDelayMs?: number; // default: 1000
  retryMaxDelayMs?: number; // default: 30_000
}
