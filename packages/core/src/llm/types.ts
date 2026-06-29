import type {
  ProviderName as ProtocolProviderName,
  ThinkingEffort as ProtocolThinkingEffort,
} from "@diligent/protocol";
import type { EventStream } from "../event-stream";
import type { AssistantMessage, ContentBlock, Message, StopReason, Usage } from "../types";

export interface SystemSection {
  tag?: string; // XML wrapper: "knowledge", "user_instructions", "collaboration_mode"
  tagAttributes?: Record<string, string>; // e.g. { path: "/p/AGENTS.md" }
  label: string; // debug label: "base", "knowledge", "mode"
  content: string; // raw text content
  cacheControl?: "ephemeral"; // hint for Anthropic cache breakpoints
}

export type ThinkingEffort = ProtocolThinkingEffort;

export type ProviderName = ProtocolProviderName;

export interface ModelInfo {
  id: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  supportsThinking: boolean;
  supportedEfforts?: ThinkingEffort[];
  supportsVision?: boolean;
}

export interface Model {
  id: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPer1M?: number; // cost per 1M input tokens in USD
  outputCostPer1M?: number; // cost per 1M output tokens in USD
  cacheReadCostPer1M?: number; // cost per 1M cache-read tokens in USD
  cacheWriteCostPer1M?: number; // cost per 1M cache-write tokens in USD
  supportsThinking: boolean;
  supportedEfforts?: ThinkingEffort[];
  supportsVision?: boolean;
  defaultBudgetTokens?: number; // fallback when thinkingBudgets absent
  supportsAdaptiveThinking?: boolean; // opus/sonnet/fable: model decides budget
  thinkingBudgets?: {
    // effort-level budgets for non-adaptive models
    low: number;
    medium: number;
    high: number;
    max: number;
  };
}

export function resolveMaxTokens(model: Model, reservePercent = 16): number {
  const normalizedReservePercent = Number.isFinite(reservePercent) ? Math.min(Math.max(reservePercent, 0), 100) : 16;
  const bufferedContextTokens = Math.floor(model.contextWindow * (normalizedReservePercent / 100));
  return Math.max(1, Math.min(model.maxOutputTokens, bufferedContextTokens));
}

// D003: StreamFunction — the provider contract
export type StreamFunction = (
  model: Model,
  context: StreamContext,
  options: StreamOptions,
) => EventStream<ProviderEvent, ProviderResult>;

export interface StreamContext {
  cwd?: string;
  systemPrompt: SystemSection[];
  messages: Message[];
  tools: ToolDefinition[];
  compactionSummary?: Record<string, unknown>;
}

export interface StreamOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  sessionId?: string;
  effort?: ThinkingEffort;
  /** Sticky routing token shared across retries within a single turn. Set once from the
   *  first successful response header; replayed on subsequent requests in the same turn. */
  turnStateRef?: { value: string | undefined };
}

export interface WebToolUserLocation {
  type: "approximate";
  city?: string;
  region?: string;
  country?: string;
  timezone?: string;
}

export interface FunctionToolDefinition {
  kind: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProviderBuiltinToolDefinition {
  kind: "provider_builtin";
  capability: "web";
  options?: {
    maxUses?: number;
    allowedDomains?: string[];
    blockedDomains?: string[];
    citationsEnabled?: boolean;
    maxContentTokens?: number;
    userLocation?: WebToolUserLocation;
  };
}

export type ToolDefinition = FunctionToolDefinition | ProviderBuiltinToolDefinition;

// Provider error classification (D010)
export type ProviderErrorType =
  | "rate_limit" // 429 — NOT retryable, retry-after is surfaced for diagnostics
  | "server_error" // 5xx and transient provider server failures — retryable
  | "context_overflow" // 400 with "context length" — NOT retryable, triggers compaction
  | "auth" // 401/403 — NOT retryable, fatal
  | "network" // ECONNREFUSED, timeout — retryable
  | "unknown"; // everything else — NOT retryable

const CONTEXT_OVERFLOW_ERROR_MESSAGE =
  "This conversation has exceeded the AI model's context limit. To continue, open the menu in the top-left corner and start a new chat.";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly errorType: ProviderErrorType,
    public readonly isRetryable: boolean,
    public readonly retryAfterMs?: number,
    public readonly statusCode?: number,
    public readonly cause?: Error,
  ) {
    super(errorType === "context_overflow" ? CONTEXT_OVERFLOW_ERROR_MESSAGE : message);
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
  | { type: "content_block"; block: ContentBlock }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; delta: string }
  | { type: "tool_call_end"; id: string; name: string; input: Record<string, unknown> }
  | { type: "usage"; usage: Usage }
  | { type: "done"; stopReason: StopReason; message: AssistantMessage }
  | { type: "error"; error: Error };

export interface ProviderResult {
  message: AssistantMessage;
}
