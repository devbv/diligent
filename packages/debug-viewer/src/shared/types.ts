// Convention-based types — duplicated from @diligent/core by convention, NOT imported (DV-01)

// Content blocks (mirrors core/src/types.ts)
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

export type ContentBlock = TextBlock | ImageBlock | ThinkingBlock | ToolCallBlock;

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error" | "aborted";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// Session entry types (D036-REV JSONL format)
export interface SessionHeader {
  type: "session_header";
  id: string;
  timestamp: number;
  cwd: string;
  version: string;
}

export interface UserMessageEntry {
  id: string;
  parentId?: string;
  role: "user";
  content: string | ContentBlock[];
  timestamp: number;
}

export interface AssistantMessageEntry {
  id: string;
  parentId?: string;
  role: "assistant";
  content: ContentBlock[];
  model: string;
  usage: Usage;
  stopReason: StopReason;
  timestamp: number;
}

export interface ToolResultEntry {
  id: string;
  parentId?: string;
  role: "tool_result";
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
  timestamp: number;
}

export interface CompactionEntry {
  id: string;
  parentId?: string;
  type: "compaction";
  summary: string;
  details: {
    readFiles: string[];
    modifiedFiles: string[];
  };
  timestamp: number;
}

export type SessionEntry = SessionHeader | UserMessageEntry | AssistantMessageEntry | ToolResultEntry | CompactionEntry;

// Knowledge (D081)
export interface KnowledgeEntry {
  id: string;
  timestamp: number;
  sessionId: string;
  type: "pattern" | "decision" | "discovery" | "preference" | "correction";
  content: string;
  confidence: number;
  supersedes?: string;
  tags: string[];
}

// Derived types
export interface SessionMeta {
  id: string;
  filePath: string;
  timestamp: number;
  messageCount: number;
  toolCallCount: number;
  hasErrors: boolean;
  lastActivity: number;
}

export interface SessionTree {
  entries: Map<string, SessionEntry>;
  children: Map<string, string[]>;
  roots: string[];
}

export interface ToolCallPair {
  call: ToolCallBlock;
  result: ToolResultEntry | undefined;
  assistantMessageId: string;
  startTime: number;
  endTime: number | undefined;
}
