import type { Model, StreamContext, StreamFunction } from "../provider/types";
import type { Message, TextBlock } from "../types";
import type { CompactionDetails, SessionEntry } from "./types";

/**
 * Estimate token count from message content.
 * Uses chars/4 heuristic (D038 — matches pi-agent).
 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      chars += typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content).length;
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "tool_call") chars += JSON.stringify(block.input).length + block.name.length;
      }
    } else if (msg.role === "tool_result") {
      chars += msg.output.length;
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Check if compaction should trigger.
 * D038: contextTokens > contextWindow - reserveTokens
 */
export function shouldCompact(estimatedTokens: number, contextWindow: number, reserveTokens: number): boolean {
  return estimatedTokens > contextWindow - reserveTokens;
}

export interface CutPointResult {
  /** Index into path entries — first entry to keep in context */
  firstKeptIndex: number;
  /** Entries to summarize (0..firstKeptIndex-1) */
  entriesToSummarize: SessionEntry[];
  /** Entries to keep (firstKeptIndex..end) */
  entriesToKeep: SessionEntry[];
}

/**
 * Find where to cut the conversation for compaction.
 * Simple cut points: always cut at user message boundaries (turn boundaries).
 * Walk backwards from the end, accumulating estimated tokens,
 * until we've reached keepRecentTokens worth of messages.
 */
export function findCutPoint(pathEntries: SessionEntry[], keepRecentTokens: number): CutPointResult {
  if (pathEntries.length === 0) {
    return { firstKeptIndex: 0, entriesToSummarize: [], entriesToKeep: [] };
  }

  // Find the last compaction entry — only summarize entries AFTER it
  let startIndex = 0;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries[i].type === "compaction") {
      startIndex = i + 1;
      break;
    }
  }

  // Walk backwards from the end, accumulating token estimates
  let accumulatedTokens = 0;
  let cutIndex = startIndex; // default: nothing to summarize (keep everything)
  let found = false;

  for (let i = pathEntries.length - 1; i >= startIndex; i--) {
    const entry = pathEntries[i];
    if (entry.type === "message") {
      const tokens = estimateTokens([entry.message]);
      accumulatedTokens += tokens;
    }
    if (accumulatedTokens >= keepRecentTokens) {
      cutIndex = i;
      found = true;
      break;
    }
  }

  // If everything fits in the budget, nothing to summarize
  if (!found) {
    return {
      firstKeptIndex: startIndex,
      entriesToSummarize: [],
      entriesToKeep: pathEntries.slice(startIndex),
    };
  }

  // Snap to the nearest user message boundary at or after cutIndex
  // A turn starts with a user message — never cut mid-turn
  for (let i = cutIndex; i < pathEntries.length; i++) {
    const entry = pathEntries[i];
    if (entry.type === "message" && entry.message.role === "user") {
      cutIndex = i;
      break;
    }
  }

  // If cutIndex hasn't moved past startIndex, nothing to summarize
  if (cutIndex <= startIndex) {
    return {
      firstKeptIndex: startIndex,
      entriesToSummarize: [],
      entriesToKeep: pathEntries.slice(startIndex),
    };
  }

  return {
    firstKeptIndex: cutIndex,
    entriesToSummarize: pathEntries.slice(startIndex, cutIndex),
    entriesToKeep: pathEntries.slice(cutIndex),
  };
}

// --- Summarization ---

const SUMMARIZATION_PROMPT = `Summarize the following coding session conversation.
Use this exact structure:

## Goal
What the user is trying to accomplish.

## Progress
### Done
- Completed tasks with specific details (file paths, function names).
### In Progress
- Tasks started but not finished.
### Blocked
- Issues preventing progress.

## Key Decisions
- Technical decisions made with brief rationale.

## Next Steps
- What should happen next.

## Critical Context
- Important details that must not be lost (variable names, API endpoints, error messages, etc.).

Be concise but preserve all actionable information. File paths and code identifiers are critical.`;

const UPDATE_SUMMARIZATION_PROMPT = `Update the existing session summary with new information.
Rules:
- PRESERVE all information from the previous summary
- ADD new progress, decisions, and context
- MOVE "In Progress" items to "Done" when completed
- UPDATE "Next Steps" based on new accomplishments
- Keep the same structure

Previous summary:
{previousSummary}

New conversation to integrate:`;

/**
 * Generate a compaction summary using an LLM call.
 * D037: LLM-based with iterative summary updating.
 */
export async function generateSummary(
  messages: Message[],
  streamFunction: StreamFunction,
  model: Model,
  options: {
    previousSummary?: string;
    signal?: AbortSignal;
  },
): Promise<string> {
  const prompt = options.previousSummary
    ? UPDATE_SUMMARIZATION_PROMPT.replace("{previousSummary}", options.previousSummary)
    : SUMMARIZATION_PROMPT;

  const context: StreamContext = {
    systemPrompt: prompt,
    messages,
    tools: [],
  };

  const providerStream = streamFunction(model, context, {
    signal: options.signal,
    maxTokens: 4096,
  });

  const result = await providerStream.result();
  const textBlocks = result.message.content.filter((b): b is TextBlock => b.type === "text");
  return textBlocks.map((b) => b.text).join("\n");
}

/**
 * D039: Extract file operations from messages being compacted.
 * Pairs tool_result messages with their preceding tool_call blocks.
 * Cumulative: merges with previous compaction's file ops.
 */
export function extractFileOperations(messages: Message[], previousDetails?: CompactionDetails): CompactionDetails {
  const readFiles = new Set(previousDetails?.readFiles ?? []);
  const modifiedFiles = new Set(previousDetails?.modifiedFiles ?? []);

  // Build a map of toolCallId → tool call info from assistant messages
  const toolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "tool_call") {
          toolCalls.set(block.id, { name: block.name, input: block.input });
        }
      }
    }
  }

  for (const msg of messages) {
    if (msg.role !== "tool_result") continue;
    const call = toolCalls.get(msg.toolCallId);
    if (!call) continue;

    const filePath = (call.input.file_path ?? call.input.path) as string | undefined;
    if (!filePath) continue;

    if (call.name === "read") {
      readFiles.add(filePath);
    } else if (call.name === "write" || call.name === "edit") {
      modifiedFiles.add(filePath);
    }
  }

  return {
    readFiles: [...readFiles],
    modifiedFiles: [...modifiedFiles],
  };
}

/**
 * D039: Append file operation summary to compaction summary.
 */
export function formatFileOperations(details: CompactionDetails): string {
  const lines: string[] = [];
  if (details.readFiles.length > 0) {
    lines.push(`\n## Files Read\n${details.readFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (details.modifiedFiles.length > 0) {
    lines.push(`\n## Files Modified\n${details.modifiedFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  return lines.join("\n");
}
