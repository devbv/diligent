import type { Model, StreamFunction } from "../provider/types";
import type { Tool } from "../tool/types";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "../types";

export type MessageDelta = { type: "text_delta"; delta: string } | { type: "thinking_delta"; delta: string };

// D086: Serializable error representation for events crossing core↔consumer boundary
export interface SerializableError {
  message: string;
  name: string;
  stack?: string;
}

// D004: 15 AgentEvent types — D086: itemId on grouped subtypes, SerializableError
export type AgentEvent =
  // Lifecycle (2)
  | { type: "agent_start" }
  | { type: "agent_end"; messages: Message[] }
  // Turn (2)
  | { type: "turn_start"; turnId: string }
  | { type: "turn_end"; turnId: string; message: AssistantMessage; toolResults: ToolResultMessage[] }
  // Message streaming (3) — D086: itemId groups related events
  | { type: "message_start"; itemId: string; message: AssistantMessage }
  | { type: "message_delta"; itemId: string; message: AssistantMessage; delta: MessageDelta }
  | { type: "message_end"; itemId: string; message: AssistantMessage }
  // Tool execution (3) — D086: itemId groups related events
  | { type: "tool_start"; itemId: string; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_update"; itemId: string; toolCallId: string; toolName: string; partialResult: string }
  | { type: "tool_end"; itemId: string; toolCallId: string; toolName: string; output: string; isError: boolean }
  // Status (1)
  | { type: "status_change"; status: "idle" | "busy" | "retry"; retry?: { attempt: number; delayMs: number } }
  // Usage (1)
  | { type: "usage"; usage: Usage; cost: number }
  // Error (1) — D086: SerializableError instead of Error
  | { type: "error"; error: SerializableError; fatal: boolean }
  // Compaction (2) — Phase 3b
  | { type: "compaction_start"; estimatedTokens: number }
  | { type: "compaction_end"; tokensBefore: number; tokensAfter: number; summary: string }
  // Knowledge (1) — Phase 3b
  | { type: "knowledge_saved"; knowledgeId: string; content: string };

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
