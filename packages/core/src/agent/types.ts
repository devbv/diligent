// @summary Agent public types and event stream primitives for the core runner

import type { NativeCompactFn } from "../llm/provider/native-compaction";
import type { ProviderErrorType, StreamFunction, ThinkingEffort } from "../llm/types";
import type {
  AssistantMessage,
  ContentBlock,
  ImageBlock,
  Message,
  ToolRenderPayloadLike,
  ToolResultMessage,
  Usage,
} from "../types";

export type MessageDelta =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "content_block_delta"; block: ContentBlock };

// D086: Serializable error representation for events crossing core↔consumer boundary
export interface SerializableError {
  message: string;
  name: string;
  stack?: string;
  code?: string;
  providerErrorType?: ProviderErrorType;
  isRetryable?: boolean;
  retryAfterMs?: number;
  statusCode?: number;
}

// D004: 15 CoreAgentEvent types emitted by loop.ts — D086: itemId on grouped subtypes, SerializableError
export type CoreAgentEvent =
  // Lifecycle (2)
  | { type: "agent_start" }
  | { type: "agent_end"; messages: Message[] }
  // Turn (2)
  | { type: "turn_start"; turnId: string; childThreadId?: string; nickname?: string; turnNumber?: number }
  | { type: "turn_end"; turnId: string; message: AssistantMessage; toolResults: ToolResultMessage[] }
  // Message streaming (3) — D086: itemId groups related events
  | { type: "message_start"; itemId: string; message: AssistantMessage; childThreadId?: string; nickname?: string }
  | {
      type: "message_discarded";
      itemId: string;
      error: SerializableError;
      nextAttempt: number;
      maxAttempts: number;
      delayMs: number;
      childThreadId?: string;
      nickname?: string;
    }
  | {
      type: "message_delta";
      itemId: string;
      message: AssistantMessage;
      delta: MessageDelta;
      childThreadId?: string;
      nickname?: string;
    }
  | { type: "message_end"; itemId: string; message: AssistantMessage; childThreadId?: string; nickname?: string }
  // Tool execution (3) — D086: itemId groups related events
  | {
      type: "tool_start";
      itemId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      childThreadId?: string;
      nickname?: string;
    }
  | {
      type: "tool_update";
      itemId: string;
      toolCallId: string;
      toolName: string;
      partialResult: string;
      childThreadId?: string;
      nickname?: string;
    }
  | {
      type: "tool_end";
      itemId: string;
      toolCallId: string;
      toolName: string;
      output: string;
      outputImages?: ImageBlock[];
      isError: boolean;
      render?: ToolRenderPayloadLike;
      metadata?: Record<string, unknown>;
      childThreadId?: string;
      nickname?: string;
    }
  // Status (1)
  | { type: "status_change"; status: "idle" | "busy" }
  // Usage (1)
  | { type: "usage"; usage: Usage }
  // Prompt debug (1)
  | {
      type: "prompt_signature";
      sessionId?: string;
      messageCount: number;
      signature: string;
      hashes: string[];
    }
  // Error (1) — D086: SerializableError instead of Error
  | { type: "error"; error: SerializableError; fatal: boolean }
  // Steering (1) — P1
  | { type: "steering_injected"; messageCount: number; messages: Message[]; steerIds: string[] }
  // Compaction (2)
  | { type: "compaction_start"; estimatedTokens: number }
  | {
      type: "compaction_end";
      tokensBefore: number;
      tokensAfter: number;
      summary: string;
      compactionSummary?: Record<string, unknown>;
    };

export type AgentListener = (event: CoreAgentEvent) => void;

export interface QueuedSteeringMessage {
  id: string;
  message: Message;
}

export class AgentStream {
  private listeners = new Set<AgentListener>();

  emit(event: CoreAgentEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  subscribe(fn: AgentListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export interface CompactionConfig {
  reservePercent: number;
  keepRecentTokens: number;
  timeoutMs?: number;
}

export interface LLMRetryConfig {
  maxRetries: number; // D010: default 5
  baseDelayMs: number; // default: 1000
  maxDelayMs: number; // default: 30_000
}

// D008: Loop control configuration — timing and compaction knobs only
export interface AgentOptions {
  cwd?: string;
  effort?: ThinkingEffort;
  retry?: LLMRetryConfig;
  compaction?: CompactionConfig;
  /** Explicit stream function — overrides the global stream resolver. Use in tests and custom extensions. */
  llmMsgStreamFn?: StreamFunction;
  /** Explicit native compaction function — overrides the global compaction resolver. */
  llmCompactionFn?: NativeCompactFn;
  /**
   * Soft plan reminder: re-inject the unfinished plan steps into the conversation tail
   * after this many agent loop iterations ("turns") without the plan being surfaced.
   * Resets whenever the model calls the `plan` tool (its update is itself a recite) or a
   * reminder fires. 0/undefined disables the feature (no behavior change).
   */
  planReminderIntervalTurns?: number;
}
