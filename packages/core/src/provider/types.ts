import type { EventStream } from "../event-stream";
import type { AssistantMessage, Message, StopReason, Usage } from "../types";

export interface Model {
  id: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPer1M?: number; // cost per 1M input tokens in USD
  outputCostPer1M?: number; // cost per 1M output tokens in USD
}

// D003: StreamFunction — the provider contract
export type StreamFunction = (
  model: Model,
  context: StreamContext,
  options: StreamOptions,
) => EventStream<ProviderEvent, ProviderResult>;

export interface StreamContext {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
}

export interface StreamOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Provider error classification (D010)
export type ProviderErrorType =
  | "rate_limit" // 429 — retryable, respect retry-after
  | "overloaded" // 529 — retryable
  | "context_overflow" // 400 with "context length" — NOT retryable, triggers compaction
  | "auth" // 401/403 — NOT retryable, fatal
  | "network" // ECONNREFUSED, timeout — retryable
  | "unknown"; // everything else — NOT retryable

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly errorType: ProviderErrorType,
    public readonly isRetryable: boolean,
    public readonly retryAfterMs?: number,
    public readonly statusCode?: number,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// Provider events — 11 types
export type ProviderEvent =
  | { type: "start" }
  | { type: "text_delta"; delta: string }
  | { type: "text_end"; text: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_end"; thinking: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; delta: string }
  | { type: "tool_call_end"; id: string; name: string; input: Record<string, unknown> }
  | { type: "usage"; usage: Usage }
  | { type: "done"; stopReason: StopReason; message: AssistantMessage }
  | { type: "error"; error: Error };

export interface ProviderResult {
  message: AssistantMessage;
}
