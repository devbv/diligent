// @summary JSONL parser and tree builder for session data

import { basename } from "node:path";
import { createLogger, type Logger } from "@diligent/logging";
import type {
  CompactionEntry,
  ContentBlock,
  SessionEntry,
  SessionHeader,
  SessionMeta,
  SessionTree,
  ToolCallBlock,
  ToolCallPair,
  ToolResultEntry,
  Usage,
} from "../shared/types.js";

interface DetectEntryContext {
  sessionId?: string;
  logger?: Logger;
}

const parserLogger = createLogger({
  scope: "debug-viewer",
  context: { component: "server.parser" },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function asParentId(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseUsage(value: unknown): Usage {
  if (!isRecord(value)) {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }
  return {
    inputTokens: typeof value.inputTokens === "number" ? value.inputTokens : 0,
    outputTokens: typeof value.outputTokens === "number" ? value.outputTokens : 0,
    cacheReadTokens: typeof value.cacheReadTokens === "number" ? value.cacheReadTokens : 0,
    cacheWriteTokens: typeof value.cacheWriteTokens === "number" ? value.cacheWriteTokens : 0,
  };
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type === "text") {
    return typeof value.text === "string";
  }
  if (value.type === "thinking") {
    return typeof value.thinking === "string";
  }
  if (value.type === "tool_call") {
    return typeof value.id === "string" && typeof value.name === "string" && isRecord(value.input);
  }
  if (value.type === "image") {
    return (
      isRecord(value.source) &&
      value.source.type === "base64" &&
      typeof value.source.media_type === "string" &&
      typeof value.source.data === "string"
    );
  }
  return false;
}

function parseContentBlocks(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isContentBlock);
}

function parseUserContent(value: unknown): string | ContentBlock[] {
  if (typeof value === "string") {
    return value;
  }
  return parseContentBlocks(value);
}

/**
 * Detect entry type from raw parsed JSON.
 * Supports two formats:
 *   1. Core envelope format: { type: "session"|"message", ... }
 *   2. Legacy flat format (sample data): { role: "user"|"assistant"|"tool_result", ... }
 */
export function detectEntryType(raw: Record<string, unknown>, context?: DetectEntryContext): SessionEntry | null {
  // --- Core envelope format (from @diligent/core session persistence) ---

  // Session header: { type: "session", version, id, timestamp (ISO), cwd }
  if (raw.type === "session") {
    const id = asString(raw.id);
    const cwd = asString(raw.cwd);
    if (!id || !cwd) {
      return null;
    }
    return {
      type: "session_header",
      id,
      timestamp: parseTimestamp(raw.timestamp),
      cwd,
      version: String(raw.version ?? "1"),
    };
  }

  // Message envelope: { type: "message", id, parentId, timestamp (ISO), message: { role, ... } }
  if (raw.type === "message" && raw.message != null) {
    if (!isRecord(raw.message)) {
      return null;
    }
    const msg = raw.message;
    const id = asString(raw.id);
    if (!id) {
      return null;
    }
    const parentId = asParentId(raw.parentId);
    const messageTimestamp = parseTimestamp(msg.timestamp);

    if (msg.role === "user") {
      return {
        id,
        parentId,
        role: "user",
        content: parseUserContent(msg.content),
        timestamp: messageTimestamp,
      };
    }
    if (msg.role === "assistant") {
      const model = asString(msg.model) ?? "unknown";
      const stopReason =
        msg.stopReason === "end_turn" ||
        msg.stopReason === "tool_use" ||
        msg.stopReason === "max_tokens" ||
        msg.stopReason === "error" ||
        msg.stopReason === "aborted"
          ? msg.stopReason
          : "error";
      return {
        id,
        parentId,
        role: "assistant",
        content: parseContentBlocks(msg.content),
        model,
        usage: parseUsage(msg.usage),
        stopReason,
        timestamp: messageTimestamp,
      };
    }
    if (msg.role === "tool_result") {
      const toolCallId = asString(msg.toolCallId);
      const toolName = asString(msg.toolName);
      if (!toolCallId || !toolName) {
        return null;
      }
      return {
        id,
        parentId,
        role: "tool_result",
        toolCallId,
        toolName,
        output: typeof msg.output === "string" ? msg.output : String(msg.output ?? ""),
        isError: asBoolean(msg.isError) ?? false,
        timestamp: messageTimestamp,
      };
    }
  }

  // --- Legacy flat format (sample data, backward compat) ---

  if (raw.role === "user") {
    const id = asString(raw.id);
    if (!id) return null;
    return {
      id,
      parentId: asParentId(raw.parentId),
      role: "user",
      content: parseUserContent(raw.content),
      timestamp: parseTimestamp(raw.timestamp),
    };
  }
  if (raw.role === "assistant") {
    const id = asString(raw.id);
    const model = asString(raw.model);
    if (!id || !model) return null;
    const stopReason =
      raw.stopReason === "end_turn" ||
      raw.stopReason === "tool_use" ||
      raw.stopReason === "max_tokens" ||
      raw.stopReason === "error" ||
      raw.stopReason === "aborted"
        ? raw.stopReason
        : "error";
    return {
      id,
      parentId: asParentId(raw.parentId),
      role: "assistant",
      content: parseContentBlocks(raw.content),
      model,
      usage: parseUsage(raw.usage),
      stopReason,
      timestamp: parseTimestamp(raw.timestamp),
    };
  }
  if (raw.role === "tool_result") {
    const id = asString(raw.id);
    const toolCallId = asString(raw.toolCallId);
    const toolName = asString(raw.toolName);
    if (!id || !toolCallId || !toolName) return null;
    return {
      id,
      parentId: asParentId(raw.parentId),
      role: "tool_result",
      toolCallId,
      toolName,
      output: typeof raw.output === "string" ? raw.output : String(raw.output ?? ""),
      isError: asBoolean(raw.isError) ?? false,
      timestamp: parseTimestamp(raw.timestamp),
    };
  }
  if (raw.type === "session_header") {
    const id = asString(raw.id);
    const cwd = asString(raw.cwd);
    if (!id || !cwd) return null;
    return {
      type: "session_header",
      id,
      timestamp: parseTimestamp(raw.timestamp),
      cwd,
      version: String(raw.version ?? "1"),
    };
  }
  if (raw.type === "compaction") {
    const id = asString(raw.id);
    const summary = asString(raw.summary);
    if (!id || !summary) return null;
    let details: CompactionEntry["details"];
    if (isRecord(raw.details)) {
      const readFiles = Array.isArray(raw.details.readFiles)
        ? raw.details.readFiles.filter((item): item is string => typeof item === "string")
        : [];
      const modifiedFiles = Array.isArray(raw.details.modifiedFiles)
        ? raw.details.modifiedFiles.filter((item): item is string => typeof item === "string")
        : [];
      details = { readFiles, modifiedFiles };
    }
    let recentUserMessages: CompactionEntry["recentUserMessages"];
    if (Array.isArray(raw.recentUserMessages)) {
      recentUserMessages = raw.recentUserMessages.filter(isRecord).map((message) => ({
        role: asString(message.role) ?? "user",
        content: parseUserContent(message.content),
        timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
      }));
    }
    return {
      id,
      parentId: asParentId(raw.parentId),
      type: "compaction",
      summary,
      recentUserMessages,
      details,
      timestamp: parseTimestamp(raw.timestamp),
    };
  }

  // System event entry types — parse with ISO timestamp conversion
  if (raw.type === "model_change") {
    const id = asString(raw.id);
    const provider = asString(raw.provider);
    const modelId = asString(raw.modelId);
    if (!id || !provider || !modelId) return null;
    return {
      id,
      parentId: asParentId(raw.parentId),
      type: "model_change",
      provider,
      modelId,
      timestamp: parseTimestamp(raw.timestamp),
    };
  }
  if (raw.type === "session_info") {
    const id = asString(raw.id);
    if (!id) return null;
    return {
      id,
      parentId: asParentId(raw.parentId),
      type: "session_info",
      name: asString(raw.name),
      timestamp: parseTimestamp(raw.timestamp),
    };
  }
  if (raw.type === "mode_change") {
    const id = asString(raw.id);
    const mode = asString(raw.mode);
    const changedBy = asString(raw.changedBy);
    if (!id || !mode || !changedBy) return null;
    return {
      id,
      parentId: asParentId(raw.parentId),
      type: "mode_change",
      mode,
      changedBy,
      timestamp: parseTimestamp(raw.timestamp),
    };
  }
  if (raw.type === "effort_change") {
    const id = asString(raw.id);
    const effort = asString(raw.effort);
    const changedBy = asString(raw.changedBy);
    if (!id || !effort || !changedBy) return null;
    return {
      id,
      parentId: asParentId(raw.parentId),
      type: "effort_change",
      effort,
      changedBy,
      timestamp: parseTimestamp(raw.timestamp),
    };
  }
  if (raw.type === "steering") {
    const id = asString(raw.id);
    const source = asString(raw.source);
    if (!id || !source || !isRecord(raw.message)) return null;
    const messageRole = asString(raw.message.role) ?? "user";
    return {
      id,
      parentId: asParentId(raw.parentId),
      type: "steering",
      message: {
        role: messageRole,
        content: parseUserContent(raw.message.content),
        timestamp: typeof raw.message.timestamp === "number" ? raw.message.timestamp : undefined,
      },
      source,
      timestamp: parseTimestamp(raw.timestamp),
    };
  }

  if (raw.type === "error") {
    const id = asString(raw.id);
    if (!id) return null;
    const errorObject = isRecord(raw.error) ? raw.error : {};
    const message = asString(errorObject.message) ?? "Unknown error";
    return {
      id,
      parentId: asParentId(raw.parentId),
      turnId: asString(raw.turnId),
      type: "error",
      fatal: Boolean(raw.fatal),
      error: {
        message,
        ...errorObject,
      },
      timestamp: parseTimestamp(raw.timestamp),
    };
  }

  // Unknown entry type — skip with warning
  (context?.logger ?? parserLogger).warn("session_entry_unknown", {
    message: "Unknown session entry type.",
    sessionId: context?.sessionId,
    fields: { raw: JSON.stringify(raw).slice(0, 300) },
  });
  return null;
}

/**
 * Parse a JSONL session file into typed entries.
 */
export async function parseSessionFile(filePath: string): Promise<SessionEntry[]> {
  const file = Bun.file(filePath);
  const text = await file.text();
  const sessionId = basename(filePath, ".jsonl");
  return parseSessionText(text, { sessionId });
}

/**
 * Parse JSONL text into typed entries.
 */
export function parseSessionText(text: string, context?: DetectEntryContext): SessionEntry[] {
  const entries: SessionEntry[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const raw = JSON.parse(trimmed);
      const result = detectEntryType(raw, context);
      if (result) {
        entries.push(result);
      }
    } catch {
      (context?.logger ?? parserLogger).warn("session_jsonl_line_parse_failed", {
        message: "Failed to parse JSONL line.",
        sessionId: context?.sessionId,
        fields: { line: trimmed.slice(0, 80) },
      });
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
  const header = entries.find((entry): entry is SessionHeader => "type" in entry && entry.type === "session_header");

  let messageCount = 0;
  let toolCallCount = 0;
  let hasErrors = false;
  let lastActivity = 0;
  let firstUserMessage: string | undefined;

  for (const entry of entries) {
    if ("role" in entry) {
      if (entry.role === "user" || entry.role === "assistant") {
        messageCount++;
      }
      if (entry.role === "user" && firstUserMessage === undefined) {
        if (typeof entry.content === "string") {
          firstUserMessage = entry.content;
        } else {
          const textParts = entry.content.filter((block) => block.type === "text").map((block) => block.text);
          if (textParts.length > 0) {
            firstUserMessage = textParts.join(" ");
          }
        }
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
    id: header?.id ?? basename(filePath, ".jsonl"),
    filePath,
    timestamp: header?.timestamp ?? lastActivity,
    firstUserMessage,
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
