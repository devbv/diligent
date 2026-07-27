// @summary Tests for agent-layer compaction helpers — token estimation, decisions, and execution
import { describe, expect, it } from "bun:test";
import { NATIVE_COMPACTION_MIN_INPUT_TOKENS } from "@diligent/core/compaction-contract";
import { EventStream } from "@diligent/core/event-stream";
import type { LocalImageLoader } from "@diligent/core/image-contract";
import type { Message, UserMessage } from "@diligent/core/message-contract";
import type {
  Model,
  ProviderEvent,
  ProviderResult,
  StreamContext,
  StreamFunction,
} from "@diligent/core/provider-contract";
import { resolveMaxTokens } from "@diligent/core/provider-contract";
import { estimateTokens, getCompactionDecision, runCompaction, shouldCompact } from "../../src/agent/compaction";
import { AgentStream } from "../../src/agent/types";
import { DEFAULT_COMPACTION_PROMPTS } from "../../src/llm/compaction";

// --- Helper factories ---

function userMsg(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMsg(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: { provider: "anthropic", modelId: "test" },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

function toolResultMsg(toolCallId: string, toolName: string, output: string): Message {
  return {
    role: "tool_result",
    toolCallId,
    toolName,
    output,
    isError: false,
    timestamp: Date.now(),
  };
}

function makeStreamFn(summaryText: string): StreamFunction {
  return (_model, _context, _options) => {
    const message = assistantMsg(summaryText) as Extract<Message, { role: "assistant" }>;
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );
    queueMicrotask(() => {
      stream.push({ type: "start" });
      stream.push({ type: "done", stopReason: "end_turn", message });
    });
    return stream;
  };
}

const TEST_MODEL: Model = {
  modelId: "test-model",
  provider: "anthropic",
  contextWindow: 100_000,
  maxOutputTokens: 40_000,
  supportsThinking: false,
};

it("default compaction prompt preserves exact critical values despite final-response secrecy constraints", () => {
  expect(DEFAULT_COMPACTION_PROMPTS.summarization).toContain("internal handoff");
  expect(DEFAULT_COMPACTION_PROMPTS.summarization).toContain("copy them verbatim");
  expect(DEFAULT_COMPACTION_PROMPTS.summarization).toContain("final user-facing response");
  expect(DEFAULT_COMPACTION_PROMPTS.summarization).toContain("Do not execute the task");
  expect(DEFAULT_COMPACTION_PROMPTS.summarization).toContain("empty tool list");
});

// --- estimateTokens ---

describe("estimateTokens", () => {
  it("estimates tokens for simple user message", () => {
    const messages: Message[] = [userMsg("hello world")]; // 11 chars → ceil(11/4) = 3
    expect(estimateTokens(messages)).toBe(3);
  });

  it("estimates tokens for assistant message", () => {
    const messages: Message[] = [assistantMsg("hello world")]; // 11 chars → 3
    expect(estimateTokens(messages)).toBe(3);
  });

  it("estimates tokens for tool result", () => {
    const output = "a".repeat(100); // 100 chars → 25
    const messages: Message[] = [toolResultMsg("tc1", "bash", output)];
    expect(estimateTokens(messages)).toBe(25);
  });

  it("returns 0 for empty messages", () => {
    expect(estimateTokens([])).toBe(0);
  });

  it("accumulates across multiple messages", () => {
    const messages: Message[] = [
      userMsg("a".repeat(40)), // 40 chars → 10
      assistantMsg("b".repeat(80)), // 80 chars → 20
      toolResultMsg("tc1", "bash", "c".repeat(120)), // 120 chars → 30
    ];
    expect(estimateTokens(messages)).toBe(60);
  });

  it("handles thinking blocks", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "a".repeat(40) },
          { type: "text", text: "b".repeat(40) },
        ],
        model: { provider: "anthropic", modelId: "test" },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: Date.now(),
      },
    ];
    expect(estimateTokens(messages)).toBe(20); // (40+40)/4
  });
});

describe("resolveMaxTokens", () => {
  it("returns the model output limit when it is smaller than the buffered context", () => {
    expect(resolveMaxTokens({ ...TEST_MODEL, maxOutputTokens: 5_000 }, 16)).toBe(5_000);
  });

  it("returns the buffered context when it is smaller than the model output limit", () => {
    expect(resolveMaxTokens(TEST_MODEL, 16)).toBe(16_000);
  });
});

// --- shouldCompact ---

// estimateTokens uses chars/4; this helper builds messages with exactly the given token count
function msgsWithTokens(tokens: number) {
  return [{ role: "user" as const, content: "x".repeat(tokens * 4), timestamp: 0 }];
}

describe("shouldCompact", () => {
  const RESERVE_PERCENT = 16; // 16% of 200k = 32000 tokens reserved

  it("returns false below threshold", () => {
    expect(shouldCompact(msgsWithTokens(100_000), 200_000, RESERVE_PERCENT)).toBe(false);
    expect(shouldCompact(msgsWithTokens(50_000), 200_000, RESERVE_PERCENT)).toBe(false);
  });

  it("returns true when tokens exceed threshold", () => {
    expect(shouldCompact(msgsWithTokens(190_000), 200_000, RESERVE_PERCENT)).toBe(true);
    expect(shouldCompact(msgsWithTokens(168_001), 200_000, RESERVE_PERCENT)).toBe(true);
  });

  it("handles edge case: exactly at threshold", () => {
    // threshold = 200000 - floor(200000 * 0.16) = 200000 - 32000 = 168000
    expect(shouldCompact(msgsWithTokens(168_000), 200_000, RESERVE_PERCENT)).toBe(false);
    expect(shouldCompact(msgsWithTokens(168_001), 200_000, RESERVE_PERCENT)).toBe(true);
  });

  it("uses the latest non-zero assistant usage", () => {
    const highUsage = assistantMsg("previous provider usage") as Extract<Message, { role: "assistant" }>;
    highUsage.usage = { inputTokens: 90_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const zeroUsageThinking: Message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "no visible output" }],
      model: { provider: "anthropic", modelId: "test" },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "end_turn",
      timestamp: Date.now(),
    };

    const decision = getCompactionDecision([userMsg("small"), highUsage, zeroUsageThinking], 100_000, 20);

    expect(decision.source).toBe("assistant_usage");
    expect(decision.estimatedTokens).toBe(91_000);
    expect(decision.shouldCompact).toBe(true);
  });
});

describe("runCompaction", () => {
  it("rejects a standard local candidate below the minimum without calling the summarizer", async () => {
    const messages: Message[] = [userMsg("x".repeat((NATIVE_COMPACTION_MIN_INPUT_TOKENS - 1) * 4))];
    let summaryCalls = 0;
    const stream = new AgentStream();
    const events: Array<{ type: string }> = [];
    stream.subscribe((event) => events.push(event));

    const result = await runCompaction({
      messages,
      model: TEST_MODEL,
      systemPrompt: [],
      compactionConfig: { reservePercent: 16 },
      llmMsgStreamFn: (model, context, options) => {
        summaryCalls += 1;
        return makeStreamFn("unused summary")(model, context, options);
      },
      stream,
    });

    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(summaryCalls).toBe(0);
    expect(events).toEqual([]);
  });

  it("uses provider usage, not just the chars/4 estimate, for candidate eligibility (QA-10459)", async () => {
    // Message content estimates below the minimum, but the latest assistant message reports a
    // context-full provider usage — the shape of a ChatGPT session whose real context is dominated
    // by the system prompt and tool schemas (which estimateTokens does not see). The usage-based
    // trigger fires, so runCompaction must proceed instead of silently no-opping on the weaker
    // estimate. Before this fix the adapter was never called and the session never compacted.
    const contextFull = assistantMsg("x".repeat((NATIVE_COMPACTION_MIN_INPUT_TOKENS - 10_000) * 4)) as Extract<
      Message,
      { role: "assistant" }
    >;
    contextFull.usage = { inputTokens: 300_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const messages: Message[] = [userMsg("follow-up"), contextFull];
    let nativeCalls = 0;

    const result = await runCompaction({
      messages,
      model: { ...TEST_MODEL, provider: "openai" },
      systemPrompt: [],
      compactionConfig: { reservePercent: 16 },
      llmMsgStreamFn: makeStreamFn("unused summary"),
      llmCompactionFn: async () => {
        nativeCalls += 1;
        return { status: "ok", compactionSummary: { type: "compaction", encrypted_content: "short" } };
      },
      stream: new AgentStream(),
    });

    expect(nativeCalls).toBe(1);
    expect(result.compacted).toBe(true);
  });

  it("adopts a native blob larger than the message estimate but smaller than provider usage (QA-10459)", async () => {
    // The shrink-gate half of QA-10459: a native compactionSummary blob duplicates conversation
    // content, so its JSON/4 estimate lands above the messages' own chars/4 estimate — while the
    // real context (provider usage, which includes system prompt and tool schemas) is far larger.
    // Comparing blob-estimate against estimate-only tokensBefore rejected every attempt, so a
    // context-full session re-triggered and re-rejected compaction on every turn, forever.
    const contextFull = assistantMsg("x".repeat(60_000 * 4)) as Extract<Message, { role: "assistant" }>;
    contextFull.usage = { inputTokens: 300_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const messages: Message[] = [userMsg("follow-up"), contextFull];

    const result = await runCompaction({
      messages,
      model: { ...TEST_MODEL, provider: "openai" },
      systemPrompt: [],
      compactionConfig: { reservePercent: 16 },
      llmMsgStreamFn: makeStreamFn("unused summary"),
      llmCompactionFn: async () => ({
        status: "ok",
        // ~100k estimated tokens: above the 60k message estimate, below the 300k provider usage.
        compactionSummary: { type: "compaction", encrypted_content: "p".repeat(100_000 * 4) },
      }),
      stream: new AgentStream(),
    });

    expect(result.compacted).toBe(true);
    expect(result.tokensBefore).toBeGreaterThanOrEqual(300_000);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it("rejects a standard native candidate below the minimum without calling the adapter", async () => {
    const messages: Message[] = [userMsg("small")];
    const priorCompactionSummary = { type: "compaction", encrypted_content: "prior" };
    let nativeCalls = 0;

    const result = await runCompaction({
      messages,
      model: { ...TEST_MODEL, provider: "openai" },
      systemPrompt: [],
      compactionSummary: priorCompactionSummary,
      compactionConfig: { reservePercent: 16 },
      llmMsgStreamFn: makeStreamFn("unused summary"),
      llmCompactionFn: async () => {
        nativeCalls += 1;
        return { status: "ok", summary: "unused native summary" };
      },
      stream: new AgentStream(),
    });

    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.compactionSummary).toBe(priorCompactionSummary);
    expect(nativeCalls).toBe(0);
  });

  it("includes prior native compaction state when checking native candidate eligibility", async () => {
    const messages: Message[] = [userMsg("small follow-up")];
    const priorCompactionSummary = {
      type: "compaction",
      encrypted_content: "p".repeat(NATIVE_COMPACTION_MIN_INPUT_TOKENS * 4),
    };
    let nativeCalls = 0;

    const result = await runCompaction({
      messages,
      model: { ...TEST_MODEL, provider: "openai" },
      systemPrompt: [],
      compactionSummary: priorCompactionSummary,
      compactionConfig: { reservePercent: 16 },
      llmMsgStreamFn: makeStreamFn("unused summary"),
      llmCompactionFn: async () => {
        nativeCalls += 1;
        return { status: "ok", compactionSummary: { type: "compaction", encrypted_content: "short" } };
      },
      stream: new AgentStream(),
    });

    expect(nativeCalls).toBe(1);
    expect(result.compacted).toBe(true);
    expect(result.compactionSummary).toEqual({ type: "compaction", encrypted_content: "short" });
  });

  it("adopts a shrinking local result at the minimum candidate size", async () => {
    const messages: Message[] = [userMsg("x".repeat(NATIVE_COMPACTION_MIN_INPUT_TOKENS * 4))];

    const result = await runCompaction({
      messages,
      model: TEST_MODEL,
      systemPrompt: [],
      compactionConfig: { reservePercent: 16 },
      llmMsgStreamFn: makeStreamFn("short summary"),
      stream: new AgentStream(),
    });

    expect(result.compacted).toBe(true);
    expect(result.messages).not.toEqual(messages);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it("rejects a nonshrinking local result and preserves the source context", async () => {
    const messages: Message[] = [userMsg("x".repeat(NATIVE_COMPACTION_MIN_INPUT_TOKENS * 4))];
    const nonshrinkingSummary = "s".repeat(NATIVE_COMPACTION_MIN_INPUT_TOKENS * 4);

    const result = await runCompaction({
      messages,
      model: TEST_MODEL,
      systemPrompt: [],
      compactionConfig: { reservePercent: 16 },
      llmMsgStreamFn: makeStreamFn(nonshrinkingSummary),
      stream: new AgentStream(),
    });

    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.tokensAfter).toBe(result.tokensBefore);
  });

  it("rejects a nonshrinking native result and preserves prior native state", async () => {
    const messages: Message[] = [userMsg("x".repeat(NATIVE_COMPACTION_MIN_INPUT_TOKENS * 4))];
    const priorCompactionSummary = { type: "compaction", encrypted_content: "prior" };

    const result = await runCompaction({
      messages,
      model: { ...TEST_MODEL, provider: "openai" },
      systemPrompt: [],
      compactionSummary: priorCompactionSummary,
      compactionConfig: { reservePercent: 16 },
      llmMsgStreamFn: makeStreamFn("unused summary"),
      llmCompactionFn: async () => ({
        status: "ok",
        compactionSummary: {
          type: "compaction",
          encrypted_content: "n".repeat((NATIVE_COMPACTION_MIN_INPUT_TOKENS + 1_000) * 4),
        },
      }),
      stream: new AgentStream(),
    });

    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.compactionSummary).toBe(priorCompactionSummary);
    expect(result.tokensAfter).toBe(result.tokensBefore);
  });

  it("does not expose the image loader to local summary models", async () => {
    let capturedContext: StreamContext | undefined;
    const summaryStream: StreamFunction = (model, context, options) => {
      capturedContext = context;
      return makeStreamFn("local summary")(model, context, options);
    };

    await runCompaction({
      messages: [
        {
          role: "user",
          timestamp: 0,
          content: [
            { type: "text", text: "x".repeat(NATIVE_COMPACTION_MIN_INPUT_TOKENS * 4) },
            { type: "local_image", path: "relative/image.png", mediaType: "image/png" },
          ],
        },
      ],
      model: TEST_MODEL,
      systemPrompt: [],
      localImageLoader: { load: async () => null },
      compactionConfig: { reservePercent: 16 },
      llmMsgStreamFn: summaryStream,
      stream: new AgentStream(),
    });

    expect(capturedContext).toBeDefined();
    expect("localImageLoader" in capturedContext!).toBe(false);
  });

  it("rebuilds summary messages when native compaction returns only display summary", async () => {
    const messages: Message[] = [userMsg("x".repeat(NATIVE_COMPACTION_MIN_INPUT_TOKENS * 4))];
    const stream = new AgentStream();
    const result = await runCompaction({
      messages,
      model: { ...TEST_MODEL, provider: "openai" },
      systemPrompt: [],
      compactionConfig: {
        reservePercent: 16,
      },
      llmMsgStreamFn: makeStreamFn("unused summary"),
      llmCompactionFn: async () => ({ status: "ok", summary: "native summary" }),
      stream,
    });

    expect(result.compacted).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.summary).toBe("native summary");
    expect(result.compactionSummary).toBeUndefined();
  });

  it("returns native compaction summary without coercing it into summary messages", async () => {
    const messages: Message[] = [userMsg("x".repeat(NATIVE_COMPACTION_MIN_INPUT_TOKENS * 4))];
    const stream = new AgentStream();
    const result = await runCompaction({
      messages,
      model: { ...TEST_MODEL, provider: "openai" },
      systemPrompt: [],
      compactionConfig: {
        reservePercent: 16,
      },
      llmMsgStreamFn: makeStreamFn("unused summary"),
      llmCompactionFn: async () => ({
        status: "ok",
        compactionSummary: { type: "compaction", encrypted_content: "opaque" },
      }),
      stream,
    });

    expect(result.compacted).toBe(true);
    expect(result.messages).toEqual([]);
    expect(result.compactionSummary).toEqual({ type: "compaction", encrypted_content: "opaque" });
  });

  it("forwards compaction state and the caller-owned image loader to native compaction", async () => {
    const messages: Message[] = [{ role: "user", content: "x".repeat(200_001), timestamp: 0 }];
    const stream = new AgentStream();
    let capturedSessionId: string | undefined;
    let capturedCompactionSummary: Record<string, unknown> | undefined;
    const localImageLoader = { load: async () => null };
    let capturedLocalImageLoader: LocalImageLoader | undefined;

    await runCompaction({
      messages,
      model: { ...TEST_MODEL, provider: "openai" },
      systemPrompt: [],
      compactionSummary: { type: "compaction", encrypted_content: "opaque" },
      sessionId: "session-123",
      localImageLoader,
      compactionConfig: {
        reservePercent: 16,
      },
      llmMsgStreamFn: makeStreamFn("unused summary"),
      llmCompactionFn: async (input) => {
        capturedSessionId = input.sessionId;
        capturedCompactionSummary = input.compactionSummary;
        capturedLocalImageLoader = input.localImageLoader;
        return {
          status: "ok",
          compactionSummary: { type: "compaction", encrypted_content: "next-opaque" },
        };
      },
      stream,
    });

    expect(capturedSessionId).toBe("session-123");
    expect(capturedCompactionSummary).toEqual({ type: "compaction", encrypted_content: "opaque" });
    expect(capturedLocalImageLoader).toBe(localImageLoader);
  });
});
