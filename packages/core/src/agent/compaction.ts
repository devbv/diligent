// @summary Agent-layer compaction helpers — shouldCompact, message selection, runCompaction

import { COMPACTION_MIN_INPUT_TOKENS, compact as llmCompact } from "../llm/compaction";
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

function getAssistantContextWindowUsage(message: AssistantMessage | undefined): number | undefined {
  if (!message) return undefined;
  const usage = message.usage;
  const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

function getLastAssistantContextWindowUsage(messages: Message[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const usage = getAssistantContextWindowUsage(message);
    if (usage !== undefined) return usage;
  }
  return undefined;
}

export function getCompactionDecision(
  allMessages: Message[],
  contextWindow: number,
  reservePercent: number,
): CompactionDecision {
  const assistantUsageTokens = getLastAssistantContextWindowUsage(allMessages);
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

export interface RunCompactionInput {
  messages: Message[];
  /** Messages kept verbatim after the compacted history, such as a newly submitted user message. */
  preservedMessages?: Message[];
  model: Model;
  systemPrompt: SystemSection[];
  compactionSummary?: Record<string, unknown>;
  sessionId?: string;
  localImageLoader?: import("../llm/image-io").LocalImageLoader;
  compactionConfig: CompactionConfig;
  llmMsgStreamFn: StreamFunction;
  llmCompactionFn?: NativeCompactFn;
  stream: AgentStream;
  signal?: AbortSignal;
  /** Context-overflow recovery may make one bounded attempt below the normal minimum. */
  bypassMinimum?: boolean;
}

export interface RunCompactionResult {
  compacted: boolean;
  summary: string;
  messages: Message[];
  compactionSummary?: Record<string, unknown>;
  tokensBefore: number;
  tokensAfter: number;
}

function estimateCompactionSummaryTokens(compactionSummary?: Record<string, unknown>): number {
  if (!compactionSummary) return 0;
  return Math.ceil(JSON.stringify(compactionSummary).length / 4);
}

function estimateEffectiveContextTokens(messages: Message[], compactionSummary?: Record<string, unknown>): number {
  return estimateTokens(messages) + estimateCompactionSummaryTokens(compactionSummary);
}

/**
 * Run compaction unconditionally: selects messages, calls LLM compact, applies summary prefix,
 * and emits compaction_start/end events. Returns the compacted message array — does not mutate in-place.
 */
export async function runCompaction(input: RunCompactionInput): Promise<RunCompactionResult> {
  const messagesToSummarize = stripOutputImagesForSummarization(input.messages);
  const preservedMessages = input.preservedMessages ?? [];
  const candidateTokens =
    estimateTokens(messagesToSummarize) +
    (input.llmCompactionFn ? estimateCompactionSummaryTokens(input.compactionSummary) : 0);
  const originalMessages = [...input.messages, ...preservedMessages];
  const tokensBefore = estimateEffectiveContextTokens(originalMessages, input.compactionSummary);
  if (!input.bypassMinimum && candidateTokens < COMPACTION_MIN_INPUT_TOKENS) {
    return {
      compacted: false,
      summary: "",
      messages: originalMessages,
      compactionSummary: input.compactionSummary,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  const timeoutMs = input.compactionConfig.timeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS;
  const compactionSignal = createCompactionSignal(input.signal, timeoutMs);
  const result = await llmCompact({
    model: input.model,
    messages: messagesToSummarize,
    systemPrompt: input.systemPrompt,
    compactionSummary: input.compactionSummary,
    sessionId: input.sessionId,
    localImageLoader: input.localImageLoader,
    config: input.compactionConfig,
    signal: compactionSignal,
    streamFn: input.llmMsgStreamFn,
    llmCompactionFn: input.llmCompactionFn,
  });
  const summary =
    result.mode === "local"
      ? `${COMPACTION_SUMMARY_PREFIX}\n\n${result.displaySummary ?? ""}`.trim()
      : (result.displaySummary ?? "");
  const messages = result.compactionSummary
    ? [...preservedMessages]
    : [{ role: "user" as const, content: summary, timestamp: Date.now() }, ...preservedMessages];
  const tokensAfterCandidate = estimateEffectiveContextTokens(messages, result.compactionSummary);
  if (tokensAfterCandidate >= tokensBefore) {
    return {
      compacted: false,
      summary: "",
      messages: originalMessages,
      compactionSummary: input.compactionSummary,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  input.stream.emit({ type: "compaction_start", estimatedTokens: tokensBefore });
  input.stream.emit({
    type: "compaction_end",
    tokensBefore,
    tokensAfter: tokensAfterCandidate,
    summary,
    compactionSummary: result.compactionSummary,
  });
  return {
    compacted: true,
    summary,
    messages,
    compactionSummary: result.compactionSummary,
    tokensBefore,
    tokensAfter: tokensAfterCandidate,
  };
}
