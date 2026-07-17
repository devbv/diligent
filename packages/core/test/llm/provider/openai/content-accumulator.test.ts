// @summary Tests the shared OpenAI-family content lifecycle accumulator independently of wire decoding
import { describe, expect, test } from "bun:test";
import { OpenAIContentAccumulator } from "../../../../src/llm/provider/openai/content-accumulator";

const USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
};

const parseJson = (value: string): Record<string, unknown> => JSON.parse(value) as Record<string, unknown>;

describe("OpenAIContentAccumulator", () => {
  test("flushes text exactly once and finalizes once", () => {
    const accumulator = new OpenAIContentAccumulator();
    expect(accumulator.appendTextDelta("Hello ")).toEqual([{ type: "text_delta", delta: "Hello " }]);
    expect(accumulator.appendTextDelta("world")).toEqual([{ type: "text_delta", delta: "world" }]);

    const finalized = accumulator.finalize({
      modelId: "test",
      finalizePendingTools: false,
    });
    expect(finalized?.events.map((event) => event.type)).toEqual(["text_end", "usage", "done"]);
    expect(finalized?.message.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(accumulator.finalize({ modelId: "test", finalizePendingTools: false })).toBeUndefined();
  });

  test("orders thinking before text when the caller closes the transition", () => {
    const accumulator = new OpenAIContentAccumulator();
    accumulator.appendThinkingDelta("Think ");
    accumulator.appendThinkingDelta("first");
    expect(accumulator.flushThinking()).toEqual([{ type: "thinking_end", thinking: "Think first" }]);
    accumulator.appendTextDelta("Answer");

    const finalized = accumulator.finalize({
      modelId: "test",
      finalizePendingTools: false,
    });
    expect(finalized?.message.content).toEqual([
      { type: "thinking", thinking: "Think first" },
      { type: "text", text: "Answer" },
    ]);
  });

  test("flushes thinking at most once when later wire deltas arrive", () => {
    const accumulator = new OpenAIContentAccumulator();
    accumulator.appendThinkingDelta("first");
    expect(accumulator.flushThinking()).toEqual([{ type: "thinking_end", thinking: "first" }]);

    expect(accumulator.appendThinkingDelta("late")).toEqual([{ type: "thinking_delta", delta: "late" }]);
    expect(accumulator.flushThinking()).toEqual([]);
    const finalized = accumulator.finalize({ modelId: "test", finalizePendingTools: false });

    expect(finalized?.message.content).toEqual([{ type: "thinking", thinking: "first" }]);
  });

  test("flushes thinking without text during finalization", () => {
    const accumulator = new OpenAIContentAccumulator();
    accumulator.appendThinkingDelta("thinking only");

    const finalized = accumulator.finalize({
      modelId: "test",
      finalizePendingTools: false,
    });
    expect(finalized?.events.map((event) => event.type)).toEqual(["thinking_end", "usage", "done"]);
    expect(finalized?.message.content).toEqual([{ type: "thinking", thinking: "thinking only" }]);
  });

  test("accumulates fragmented tool arguments with caller-supplied parsing", () => {
    const accumulator = new OpenAIContentAccumulator();
    expect(accumulator.upsertToolCall("0", { id: "tool_1", name: "read", order: 0 })).toEqual([
      { type: "tool_call_start", id: "tool_1", name: "read" },
    ]);
    accumulator.appendToolArguments("0", '{"path"');
    accumulator.appendToolArguments("0", ':"a"}');

    const finalized = accumulator.finalize({
      modelId: "test",
      finalizePendingTools: true,
      parseToolArguments: parseJson,
    });
    expect(finalized?.message.content).toEqual([
      { type: "tool_call", id: "tool_1", name: "read", input: { path: "a" } },
    ]);
  });

  test("finalizes interleaved tools in caller-provided order", () => {
    const accumulator = new OpenAIContentAccumulator();
    accumulator.upsertToolCall("1", { id: "tool_2", name: "write", order: 1 });
    accumulator.upsertToolCall("0", { id: "tool_1", name: "read", order: 0 });
    accumulator.appendToolArguments("1", '{"path":"b"}');
    accumulator.appendToolArguments("0", '{"path":"a"}');

    const finalized = accumulator.finalize({
      modelId: "test",
      finalizePendingTools: true,
      parseToolArguments: parseJson,
    });
    expect(finalized?.message.content).toEqual([
      { type: "tool_call", id: "tool_1", name: "read", input: { path: "a" } },
      { type: "tool_call", id: "tool_2", name: "write", input: { path: "b" } },
    ]);
  });

  test("keeps malformed-argument fallback policy caller-owned", () => {
    const responses = new OpenAIContentAccumulator();
    responses.upsertToolCall("tool", { id: "tool", name: "read", order: 0 });
    const responseEvents = responses.completeToolCall("tool", {
      arguments: "INVALID",
      parseArguments: () => ({}),
    });
    expect(responseEvents[0]).toMatchObject({
      type: "tool_call_end",
      input: {},
    });

    const chatCompletions = new OpenAIContentAccumulator();
    chatCompletions.upsertToolCall("tool", {
      id: "tool",
      name: "read",
      order: 0,
    });
    const chatEvents = chatCompletions.completeToolCall("tool", {
      arguments: "INVALID",
      parseArguments: (raw) => ({ _raw: raw }),
    });
    expect(chatEvents[0]).toMatchObject({
      type: "tool_call_end",
      input: { _raw: "INVALID" },
    });
  });

  test("supports mixed text and tool calls", () => {
    const accumulator = new OpenAIContentAccumulator();
    accumulator.appendTextDelta("Checking");
    accumulator.upsertToolCall("0", { id: "tool_1", name: "read", order: 0 });
    accumulator.appendToolArguments("0", "{}");

    const finalized = accumulator.finalize({
      modelId: "test",
      finalizePendingTools: true,
      parseToolArguments: parseJson,
    });
    expect(finalized?.message.content).toEqual([
      { type: "text", text: "Checking" },
      { type: "tool_call", id: "tool_1", name: "read", input: {} },
    ]);
  });

  test("accepts authoritative message content without duplicating text deltas", () => {
    const accumulator = new OpenAIContentAccumulator();
    accumulator.appendTextDelta("draft");
    expect(accumulator.acceptAuthoritativeMessage([{ type: "text", text: "final" }])).toEqual([
      { type: "text_end", text: "final" },
    ]);

    const finalized = accumulator.finalize({
      modelId: "test",
      finalizePendingTools: false,
    });
    expect(finalized?.message.content).toEqual([{ type: "text", text: "final" }]);
    expect(finalized?.events.some((event) => event.type === "text_end")).toBe(false);
  });

  test("captures a usage-only trailing payload", () => {
    const accumulator = new OpenAIContentAccumulator();
    accumulator.setUsage(USAGE);
    const finalized = accumulator.finalize({
      modelId: "test",
      finalizePendingTools: false,
    });

    expect(finalized?.events[0]).toEqual({ type: "usage", usage: USAGE });
    expect(finalized?.message.usage).toEqual(USAGE);
  });

  test("abort prevents terminal flush", () => {
    const accumulator = new OpenAIContentAccumulator();
    accumulator.appendTextDelta("partial");
    accumulator.setUsage(USAGE);
    accumulator.setStopReason("error");
    accumulator.abort();

    expect(accumulator.finalize({ modelId: "test", finalizePendingTools: false })).toBeUndefined();
  });
});
