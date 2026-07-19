// Debug-viewer local DTOs (D095/DV-01):
// - Core-level concepts may be mirrored by convention.
// - Runtime session/knowledge types are intentionally NOT imported.
// - Duplicate only fields required by debug-viewer UX/parsing.

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

export interface UsageTotals extends Usage {
  totalTokens: number;
}

export interface ModelUsageSummary {
  model: string;
  messageCount: number;
  pricedMessageCount: number;
  totalCost: number;
  totals: UsageTotals;
}

export interface UsageSummary {
  sessionCount: number;
  assistantMessageCount: number;
  pricedMessageCount: number;
  unpricedMessageCount: number;
  totalCost: number;
  totals: UsageTotals;
  modelBreakdown: ModelUsageSummary[];
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
  details?: {
    readFiles: string[];
    modifiedFiles: string[];
  };
  timestamp: number;
}

export interface ModelChangeEntry {
  id: string;
  parentId?: string;
  type: "model_change";
  provider: string;
  modelId: string;
  timestamp: number;
}

export interface SessionInfoEntry {
  id: string;
  parentId?: string;
  type: "session_info";
  name?: string;
  timestamp: number;
}

export interface ModeChangeEntry {
  id: string;
  parentId?: string;
  type: "mode_change";
  mode: string;
  changedBy: string;
  timestamp: number;
}

export interface EffortChangeEntry {
  id: string;
  parentId?: string;
  type: "effort_change";
  effort: string;
  changedBy: string;
  timestamp: number;
}

export interface SteeringEntry {
  id: string;
  parentId?: string;
  type: "steering";
  message: { role: string; content: string | ContentBlock[]; timestamp?: number };
  source: string;
  timestamp: number;
}

export interface ErrorEntry {
  id: string;
  parentId?: string;
  turnId?: string;
  type: "error";
  fatal: boolean;
  error: {
    message: string;
    [key: string]: unknown;
  };
  timestamp: number;
}

export type SessionEntry =
  | SessionHeader
  | UserMessageEntry
  | AssistantMessageEntry
  | ToolResultEntry
  | CompactionEntry
  | ModelChangeEntry
  | SessionInfoEntry
  | ModeChangeEntry
  | EffortChangeEntry
  | SteeringEntry
  | ErrorEntry;

// Knowledge (D081)
export interface KnowledgeEntry {
  id: string;
  timestamp: number;
  sessionId: string;
  type: "pattern" | "discovery" | "preference" | "correction" | "backlog";
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
  firstUserMessage?: string;
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
