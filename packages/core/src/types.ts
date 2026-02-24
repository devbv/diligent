// Content blocks
export type ContentBlock = TextBlock | ImageBlock | ThinkingBlock | ToolCallBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Messages (D005: unified, inline content)
export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  model: string;
  usage: Usage;
  stopReason: StopReason;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "tool_result";
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error" | "aborted";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
