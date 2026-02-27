import type { Model, StreamFunction } from "../provider/types";
import type { Tool } from "../tool/types";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "../types";

// D087: Collaboration modes
export type ModeKind = "default" | "plan" | "execute";

/**
 * Tools available in plan mode (read-only exploration only).
 * Bash, write, edit, add_knowledge are excluded.
 */
export const PLAN_MODE_ALLOWED_TOOLS = new Set(["read_file", "glob", "grep", "ls"]);

/**
 * System prompt prefixes injected per mode.
 * Empty string for "default" — no prefix added, current behavior preserved.
 */
export const MODE_SYSTEM_PROMPT_PREFIXES: Record<ModeKind, string> = {
  default: "",
  plan: [
    "You are operating in PLAN MODE.",
    "You may ONLY read files, search code, and explore the codebase.",
    "You must NOT create, edit, delete, or write any files.",
    "Do not run bash commands.",
    "Focus on understanding the codebase and producing a plan.",
    "When ready, output your plan inside a <proposed_plan> block.",
    "",
  ].join("\n"),
  execute: [
    "You are operating in EXECUTE MODE.",
    "Work autonomously toward the goal. Make reasonable assumptions rather than asking questions.",
    "Report significant progress milestones as you work.",
    "Complete the full task before stopping.",
    "",
  ].join("\n"),
};

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
  | { type: "knowledge_saved"; knowledgeId: string; content: string }
  // Loop detection (1) — P0
  | { type: "loop_detected"; patternLength: number; toolName: string };

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
  mode?: ModeKind; // D087: defaults to "default"
}
