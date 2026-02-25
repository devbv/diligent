import type {
  AssistantMessageEntry,
  CompactionEntry,
  SessionEntry,
  SessionHeader,
  SessionMeta,
  SessionTree,
  ToolCallBlock,
  ToolCallPair,
  ToolResultEntry,
  UserMessageEntry,
} from "../shared/types.js";

/**
 * Detect entry type from raw parsed JSON.
 * Strategy: check `role` first, then `type`, then skip with warning.
 */
export function detectEntryType(raw: Record<string, unknown>): SessionEntry | null {
  // Check role-based entries first
  if (raw.role === "user") {
    return raw as unknown as UserMessageEntry;
  }
  if (raw.role === "assistant") {
    return raw as unknown as AssistantMessageEntry;
  }
  if (raw.role === "tool_result") {
    return raw as unknown as ToolResultEntry;
  }

  // Check type-based entries
  if (raw.type === "session_header") {
    return raw as unknown as SessionHeader;
  }
  if (raw.type === "compaction") {
    return raw as unknown as CompactionEntry;
  }

  // Unknown entry type — skip with warning
  console.warn("Unknown session entry type:", JSON.stringify(raw).slice(0, 100));
  return null;
}

/**
 * Parse a JSONL session file into typed entries.
 */
export async function parseSessionFile(filePath: string): Promise<SessionEntry[]> {
  const file = Bun.file(filePath);
  const text = await file.text();
  return parseSessionText(text);
}

/**
 * Parse JSONL text into typed entries.
 */
export function parseSessionText(text: string): SessionEntry[] {
  const entries: SessionEntry[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const raw = JSON.parse(trimmed);
      const entry = detectEntryType(raw);
      if (entry) {
        entries.push(entry);
      }
    } catch {
      console.warn("Failed to parse JSONL line:", trimmed.slice(0, 80));
    }
  }

  return entries;
}

/**
 * Get the ID of an entry (session_header uses id field, messages use id field).
 */
function getEntryId(entry: SessionEntry): string {
  return entry.id;
}

/**
 * Get the parentId of an entry, if it has one.
 */
function getParentId(entry: SessionEntry): string | undefined {
  if ("parentId" in entry) {
    return entry.parentId;
  }
  return undefined;
}

/**
 * Build a tree structure from session entries.
 */
export function buildTree(entries: SessionEntry[]): SessionTree {
  const entryMap = new Map<string, SessionEntry>();
  const children = new Map<string, string[]>();
  const roots: string[] = [];

  for (const entry of entries) {
    const id = getEntryId(entry);
    entryMap.set(id, entry);

    const parentId = getParentId(entry);
    if (parentId) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(id);
      children.set(parentId, siblings);
    } else {
      roots.push(id);
    }
  }

  return { entries: entryMap, children, roots };
}

/**
 * Pair tool calls (from AssistantMessage.content) with their results (ToolResultEntry).
 */
export function pairToolCalls(entries: SessionEntry[]): ToolCallPair[] {
  const pairs: ToolCallPair[] = [];

  // Index tool results by toolCallId
  const resultMap = new Map<string, ToolResultEntry>();
  for (const entry of entries) {
    if ("role" in entry && entry.role === "tool_result") {
      resultMap.set(entry.toolCallId, entry);
    }
  }

  // Walk assistant messages and extract tool calls
  for (const entry of entries) {
    if ("role" in entry && entry.role === "assistant") {
      for (const block of entry.content) {
        if (block.type === "tool_call") {
          const toolCall = block as ToolCallBlock;
          const result = resultMap.get(toolCall.id);
          pairs.push({
            call: toolCall,
            result,
            assistantMessageId: entry.id,
            startTime: entry.timestamp,
            endTime: result?.timestamp,
          });
        }
      }
    }
  }

  return pairs;
}

/**
 * Extract metadata from a session file's entries.
 */
export function extractSessionMeta(filePath: string, entries: SessionEntry[]): SessionMeta {
  const header = entries.find((e) => "type" in e && e.type === "session_header") as SessionHeader | undefined;

  let messageCount = 0;
  let toolCallCount = 0;
  let hasErrors = false;
  let lastActivity = 0;

  for (const entry of entries) {
    if ("role" in entry) {
      if (entry.role === "user" || entry.role === "assistant") {
        messageCount++;
      }
      if (entry.role === "tool_result") {
        toolCallCount++;
        if (entry.isError) hasErrors = true;
      }
    }
    if ("timestamp" in entry && entry.timestamp > lastActivity) {
      lastActivity = entry.timestamp;
    }
  }

  return {
    id: header?.id ?? filePath.split("/").pop()?.replace(".jsonl", "") ?? "unknown",
    filePath,
    timestamp: header?.timestamp ?? lastActivity,
    messageCount,
    toolCallCount,
    hasErrors,
    lastActivity,
  };
}

/**
 * Incremental parser for live-tailing JSONL files.
 * Tracks file offset and partial line buffer for efficient reads.
 */
export class IncrementalParser {
  private offset = 0;
  private partialLine = "";

  async readNew(filePath: string): Promise<SessionEntry[]> {
    const file = Bun.file(filePath);
    const size = file.size;

    if (size <= this.offset) {
      return [];
    }

    const content = await file.slice(this.offset).text();
    this.offset = size;

    const lines = (this.partialLine + content).split("\n");
    this.partialLine = lines.pop() ?? "";

    const entries: SessionEntry[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed);
        const entry = detectEntryType(raw);
        if (entry) entries.push(entry);
      } catch {
        // skip malformed lines
      }
    }

    return entries;
  }

  reset(): void {
    this.offset = 0;
    this.partialLine = "";
  }
}
