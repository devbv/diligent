// @summary Agent public types and event stream primitives for the core runner

import type { Logger } from "@diligent/logging";
import type { MessageDelta, SerializableError } from "@diligent/protocol";
import type { LocalImageLoader } from "../llm/image-io";
import type { NativeCompactFn } from "../llm/provider/native-compaction";
import type { StreamTurnScope } from "../llm/turn-scope";
import type { StreamFunction, ThinkingEffort } from "../llm/types";
import type { ToolOutputFileStore } from "../tool/executor";
import type { AssistantMessage, ImageBlock, Message, ToolRenderPayloadLike, ToolResultMessage, Usage } from "../types";
import type { AgentLoopHook } from "./loop-hooks";

export type { MessageDelta, SerializableError } from "@diligent/protocol";

// Core events emitted by the reusable agent engine — D086: itemId on grouped subtypes, SerializableError
export type CoreAgentEvent =
  // Lifecycle (2)
  | { type: "agent_start" }
  | { type: "agent_end"; messages: Message[] }
  // Turn (2)
  | { type: "turn_start"; turnId: string }
  | { type: "turn_end"; turnId: string; message: AssistantMessage; toolResults: ToolResultMessage[] }
  // Message streaming (3) — D086: itemId groups related events
  | { type: "message_start"; itemId: string; message: AssistantMessage }
  | {
      type: "message_discarded";
      itemId: string;
      error: SerializableError;
      nextAttempt: number;
      maxAttempts: number;
      delayMs: number;
    }
  | {
      type: "message_delta";
      itemId: string;
      message: AssistantMessage;
      delta: MessageDelta;
    }
  | { type: "message_end"; itemId: string; message: AssistantMessage }
  // Tool execution (3) — D086: itemId groups related events
  | {
      type: "tool_start";
      itemId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool_update";
      itemId: string;
      toolCallId: string;
      toolName: string;
      partialResult: string;
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
    }
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
  // Trusted in-process context injection (runtime consumes this; protocol does not)
  | {
      type: "context_injected";
      injections: Array<{
        source: string;
        message: import("../types").UserMessage;
        metadata?: Record<string, unknown>;
      }>;
    }
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
  /** Number of retries after the initial provider attempt. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_LLM_RETRY_CONFIG: Readonly<LLMRetryConfig> = {
  maxRetries: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

// D008: Loop control configuration — timing and compaction knobs only
export interface AgentOptions {
  effort?: ThinkingEffort;
  /** Structured diagnostic logger. Defaults to the local console-compatible core logger. */
  logger?: Logger;
  /** Session correlation attached structurally to logs and provider requests. */
  sessionId?: string;
  retry?: LLMRetryConfig;
  compaction?: CompactionConfig;
  /** Explicit stream function — overrides the global stream resolver. Use in tests and custom extensions. */
  llmMsgStreamFn?: StreamFunction;
  /** Explicit native compaction function — overrides the global compaction resolver. */
  llmCompactionFn?: NativeCompactFn;
  /** Caller-owned adapter for reading persisted local image blocks. */
  localImageLoader?: LocalImageLoader;
  /** Caller-owned adapter for storing full tool output when core truncates it. */
  toolOutputStore?: ToolOutputFileStore;
  /** Trusted synchronous hooks scoped to this Agent instance. */
  loopHooks?: readonly AgentLoopHook[];
}

export interface AgentPromptOptions {
  /** Caller-owned per-turn provider resource scope. */
  turnScope?: StreamTurnScope;
}
