// @summary LLM-layer compaction execution — generateSummary, compactMessages, compact (native-first)

import type { Message, TextBlock } from "../types";
import type { NativeCompactFn } from "./provider/native-compaction";
import { resolveStream } from "./stream-resolver";
import type { Model, ProviderName, StreamContext, StreamFunction, SystemSection } from "./types";
import { resolveMaxTokens } from "./types";

// --- Types ---

export interface CompactionPrompts {
  summarization: string;
}

export const DEFAULT_COMPACTION_PROMPTS: CompactionPrompts = {
  summarization: `You are performing a CONTEXT CHECKPOINT COMPACTION.
Create a handoff summary for another LLM that will resume this coding task.

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

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
File paths and code identifiers are critical.`,
};

export interface CompactMessagesResult {
  summary: string;
  recentUserMessages: Message[];
  tokensBefore: number;
  tokensAfter: number;
}

export interface LLMCompactResult {
  mode: "local" | "native";
  displaySummary?: string;
  compactionSummary?: Record<string, unknown>;
}

export interface GenerateSummaryOptions {
  signal?: AbortSignal;
  reservePercent?: number;
  prompts?: CompactionPrompts;
}

export interface LLMCompactConfig {
  reservePercent: number;
  prompts?: CompactionPrompts;
}

export interface LLMCompactInput {
  model: Model;
  /** Messages to summarize (pre-selected by caller via selectForCompaction). */
  messages: Message[];
  systemPrompt: SystemSection[];
  compactionSummary?: Record<string, unknown>;
  sessionId?: string;
  localImageLoader?: import("./image-io").LocalImageLoader;
  config: LLMCompactConfig;
  signal?: AbortSignal;
  /** Optional stream function override — for tests and custom models. When omitted, resolveStream() is used. */
  streamFn?: StreamFunction;
  /** Optional provider-native compaction function override. When omitted, resolveCompaction() is used. */
  llmCompactionFn?: NativeCompactFn;
}

type CompactionResolver = (provider: string) => NativeCompactFn | undefined;

const STATIC_COMPACTION_RESOLVERS: Partial<Record<string, CompactionResolver>> = {
  // Intentionally empty for now: authenticated providers should pass llmCompactionFn via AgentOptions.
};

export const COMPACTION_MIN_INPUT_TOKENS = 50_000;
/** @deprecated Use COMPACTION_MIN_INPUT_TOKENS. */
export const NATIVE_COMPACTION_MIN_INPUT_TOKENS = COMPACTION_MIN_INPUT_TOKENS;

/** Resolve a provider-native compaction function for the given provider from static definitions. */
export function resolveCompaction(provider: string): NativeCompactFn | undefined {
  const resolver = STATIC_COMPACTION_RESOLVERS[provider];
  return resolver?.(provider);
}

// --- Helpers ---

function resolveCompactionPrompts(prompts?: CompactionPrompts): CompactionPrompts {
  return prompts ?? DEFAULT_COMPACTION_PROMPTS;
}

// --- Public functions ---

/**
 * Generate a compaction summary using an LLM call.
 * D037: LLM-based with iterative summary updating.
 */
export async function generateSummary(
  messages: Message[],
  streamFunction: StreamFunction,
  model: Model,
  options: GenerateSummaryOptions,
): Promise<string> {
  const prompts = resolveCompactionPrompts(options.prompts);
  const prompt = prompts.summarization;

  // Ensure messages end with a user message — required when extended thinking is enabled
  const summaryMessages =
    messages.length > 0 && messages[messages.length - 1].role !== "user"
      ? [...messages, { role: "user" as const, content: "Please provide the summary now.", timestamp: Date.now() }]
      : messages;

  const context: StreamContext = {
    systemPrompt: [{ label: "system", content: prompt }],
    messages: summaryMessages,
    tools: [],
  };

  const providerStream = streamFunction(model, context, {
    signal: options.signal,
    effort: "low",
    maxTokens: resolveMaxTokens(model, options.reservePercent),
  });

  const result = await providerStream.result();
  const textBlocks = result.message.content.filter((b): b is TextBlock => b.type === "text");
  return textBlocks.map((b) => b.text).join("\n");
}

/**
 * Summarize messages and return the summary plus retained recent user messages.
 * Caller is responsible for pre-selecting messages via selectForCompaction.
 */
export async function compactMessages(
  messages: Message[],
  streamFunction: StreamFunction,
  model: Model,
  config: { reservePercent: number; prompts?: CompactionPrompts },
  signal?: AbortSignal,
): Promise<string> {
  const summary = await generateSummary(messages, streamFunction, model, {
    signal,
    reservePercent: config.reservePercent,
    prompts: resolveCompactionPrompts(config.prompts),
  });
  return summary;
}

/**
 * Summary pipeline: use provider-native compaction when available, otherwise local LLM summarization.
 */
export async function compact(input: LLMCompactInput): Promise<LLMCompactResult> {
  const nativeCompactFn = input.llmCompactionFn;

  if (nativeCompactFn) {
    const nativeResult = await nativeCompactFn({
      model: input.model,
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      compactionSummary: input.compactionSummary,
      sessionId: input.sessionId,
      localImageLoader: input.localImageLoader,
      signal: input.signal,
    });
    if (nativeResult.status === "ok") {
      return {
        mode: "native",
        displaySummary: nativeResult.summary?.trim() || undefined,
        compactionSummary: nativeResult.compactionSummary,
      };
    }
    throw new Error(
      `Native compaction is configured for provider=${input.model.provider} model=${input.model.modelId} but returned unsupported${nativeResult.reason ? `: ${nativeResult.reason}` : ""}`,
    );
  }

  const streamFunction = input.streamFn ?? resolveStream(input.model.provider as ProviderName);
  const local = await compactMessages(
    input.messages,
    streamFunction,
    input.model,
    { reservePercent: input.config.reservePercent, prompts: input.config.prompts },
    input.signal,
  );
  return {
    mode: "local",
    displaySummary: local.trim(),
  };
}
