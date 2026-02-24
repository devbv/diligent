import type { EventStream } from "../event-stream";
import type { AssistantMessage, Message, Usage, StopReason } from "../types";

export interface Model {
  id: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
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
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
