// @summary Agent-layer compaction helpers — shouldCompact, message selection, runCompaction

import { compact as llmCompact, NATIVE_COMPACTION_MIN_INPUT_TOKENS } from "../llm/compaction";
import type { NativeCompactFn } from "../llm/provider/native-compaction";
import { estimateTokens } from "../llm/tokens";
import type { Model, StreamFunction, SystemSection } from "../llm/types";
import type { AssistantMessage, Message } from "../types";
import type { AgentStream, CompactionConfig } from "./types";

const DEFAULT_COMPACTION_TIMEOUT_MS = 180_000;

function createCompactionSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export type { CompactionPrompts, CompactMessagesResult } from "../llm/compaction";
// Re-export estimateTokens and LLM-layer compaction types so consumers can import from either location
export { estimateTokens } from "../llm/tokens";

/**
 * Prefix injected before a compaction summary so the resuming model understands
 * that a prior model produced the summary (codex-style handoff framing).
 */
export const COMPACTION_SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

/**
 * Check if compaction should trigger.
 * D038: contextTokens > contextWindow * (1 - reservePercent / 100)
 *
 * Uses the last assistant message's actual provider usage tokens when available,
 * falling back to the chars/4 heuristic.
 */
export interface CompactionDecision {
  estimatedTokens: number;
  reserveTokens: number;
  thresholdTokens: number;
  shouldCompact: boolean;
  source: "assistant_usage" | "estimated_messages";
}

function getLastAssistantMessage(messages: Message[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

function getAssistantContextWindowUsage(message: AssistantMessage | undefined): number | undefined {
  if (!message) return undefined;
  const usage = message.usage;
  const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return Number.isFinite(total) ? total : undefined;
}

export function getCompactionDecision(
  allMessages: Message[],
  contextWindow: number,
  reservePercent: number,
): CompactionDecision {
  const assistantUsageTokens = getAssistantContextWindowUsage(getLastAssistantMessage(allMessages));
  const messageEstimatedTokens = estimateTokens(allMessages);
  const estimatedTokens =
    assistantUsageTokens !== undefined
      ? Math.max(assistantUsageTokens, messageEstimatedTokens)
      : messageEstimatedTokens;
  const reserveTokens = Math.floor(contextWindow * (reservePercent / 100));
  const thresholdTokens = contextWindow - reserveTokens;
  return {
    estimatedTokens,
    reserveTokens,
    thresholdTokens,
    shouldCompact: estimatedTokens > thresholdTokens,
    source:
      assistantUsageTokens !== undefined && assistantUsageTokens >= messageEstimatedTokens
        ? "assistant_usage"
        : "estimated_messages",
  };
}

export function shouldCompact(allMessages: Message[], contextWindow: number, reservePercent: number): boolean {
  return getCompactionDecision(allMessages, contextWindow, reservePercent).shouldCompact;
}

function truncateUserMessage(msg: Message, maxTokens: number): Message {
  if (msg.role !== "user") return msg;
  if (typeof msg.content !== "string") return msg;
  const maxChars = maxTokens * 4;
  if (msg.content.length <= maxChars) return msg;
  return { ...msg, content: `${msg.content.slice(0, maxChars)}\n[... truncated]` };
}

/**
 * Strip outputImages from tool_result messages before they are sent to the
 * summarizer. The summary itself is text, so re-uploading multi-MB base64
 * images for summarization wastes tokens and yields no benefit; we replace
 * them with a textual marker so the model still knows an image was loaded.
 */
function stripOutputImagesForSummarization(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== "tool_result") return msg;
    if (!msg.outputImages || msg.outputImages.length === 0) return msg;
    const count = msg.outputImages.length;
    const marker = `\n[${count} image${count > 1 ? "s" : ""} omitted from compaction]`;
    const { outputImages: _omit, ...rest } = msg;
    return { ...rest, output: msg.output + marker };
  });
}

/**
 * Select messages to summarize and recent user messages to retain.
 */
export function selectForCompaction(
  messages: Message[],
  keepRecentTokens: number,
): { messagesToSummarize: Message[]; recentUserMessages: Message[] } {
  const messagesToSummarize = stripOutputImagesForSummarization(messages);
  const userMessages = messages.filter((msg) => msg.role === "user");

  // Walk backwards within token budget
  const selected: Message[] = [];
  let accumulatedTokens = 0;

  for (let i = userMessages.length - 1; i >= 0; i--) {
    const msg = userMessages[i];
    const tokens = estimateTokens([msg]);
    if (accumulatedTokens + tokens > keepRecentTokens && selected.length > 0) {
      break;
    }
    const truncated = truncateUserMessage(msg, keepRecentTokens);
    selected.push(truncated);
    accumulatedTokens += Math.min(tokens, keepRecentTokens);
  }

  selected.reverse();

  return { messagesToSummarize, recentUserMessages: selected };
}

export interface RunCompactionInput {
  messages: Message[];
  model: Model;
  systemPrompt: SystemSection[];
  compactionSummary?: Record<string, unknown>;
  sessionId?: string;
  compactionConfig: CompactionConfig;
  llmMsgStreamFn: StreamFunction;
  llmCompactionFn?: NativeCompactFn;
  stream: AgentStream;
  signal?: AbortSignal;
}

export interface RunCompactionResult {
  summary: string;
  messages: Message[];
  compactionSummary?: Record<string, unknown>;
}

/**
 * Build the summary-based compacted conversation shape used for persisted session replay.
 */
export function buildMessagesFromCompaction(
  recentUserMessages: Message[],
  summary: string,
  timestamp: number,
): Message[] {
  return [...recentUserMessages, { role: "user" as const, content: summary, timestamp }];
}

/**
 * Split a compacted conversation shape back into the retained user tail and summary message.
 * The canonical compacted shape is [recentUserMessages..., summaryUserMessage].
 */
export function splitCompactionMessages(messages: Message[]): { recentUserMessages: Message[]; summary: string } {
  const summaryMessage = messages[messages.length - 1];
  if (!summaryMessage || summaryMessage.role !== "user" || typeof summaryMessage.content !== "string") {
    throw new Error("Compaction messages must end with a string user summary message");
  }

  const recentUserMessages = messages.slice(0, -1);
  return { recentUserMessages, summary: summaryMessage.content };
}

/**
 * Run compaction unconditionally: selects messages, calls LLM compact, applies summary prefix,
 * and emits compaction_start/end events. Returns the compacted message array — does not mutate in-place.
 */
export async function runCompaction(input: RunCompactionInput): Promise<RunCompactionResult> {
  const { messagesToSummarize, recentUserMessages } = selectForCompaction(
    input.messages,
    input.compactionConfig.keepRecentTokens,
  );
  const tokensBefore = estimateTokens(input.messages);
  const effectiveLlmCompactionFn =
    input.llmCompactionFn != null && tokensBefore < NATIVE_COMPACTION_MIN_INPUT_TOKENS
      ? undefined
      : input.llmCompactionFn;
  const timeoutMs = input.compactionConfig.timeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS;
  const compactionSignal = createCompactionSignal(input.signal, timeoutMs);
  input.stream.emit({ type: "compaction_start", estimatedTokens: tokensBefore });
  const result = await llmCompact({
    model: input.model,
    messages: messagesToSummarize,
    systemPrompt: input.systemPrompt,
    compactionSummary: input.compactionSummary,
    sessionId: input.sessionId,
    config: input.compactionConfig,
    signal: compactionSignal,
    streamFn: input.llmMsgStreamFn,
    llmCompactionFn: effectiveLlmCompactionFn,
  });
  const summary =
    result.mode === "local"
      ? `${COMPACTION_SUMMARY_PREFIX}\n\n${result.displaySummary ?? ""}`.trim()
      : (result.displaySummary ?? "");
  const messages = result.compactionSummary ? [] : buildMessagesFromCompaction(recentUserMessages, summary, Date.now());
  const tokensAfter = estimateTokens(messages);
  input.stream.emit({
    type: "compaction_end",
    tokensBefore: tokensBefore,
    tokensAfter,
    summary,
    compactionSummary: result.compactionSummary,
  });
  return { summary, messages, compactionSummary: result.compactionSummary };
}
