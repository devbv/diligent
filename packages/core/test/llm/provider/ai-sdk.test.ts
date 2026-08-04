// @summary Contract tests for the shared AI SDK to Diligent provider bridge
import { describe, expect, it } from "bun:test";
import { simulateReadableStream, type TextStreamPart, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { EventStream } from "../../../src/event-stream";
import {
  consumeAISDKStreamParts,
  convertToAISDKMessages,
  convertToAISDKTools,
  createAISDKStream,
} from "../../../src/llm/provider/ai-sdk";
import type { Model, ProviderEvent, ProviderResult } from "../../../src/llm/types";
import { ProviderError, ProviderErrorType } from "../../../src/llm/types";

const model: Model = {
  modelId: "adapter-model",
  provider: "anthropic",
  contextWindow: 100_000,
  maxOutputTokens: 8_192,
  supportsThinking: true,
};

describe("AI SDK message conversion", () => {
  it("converts images, tool metadata, and multimodal tool results", async () => {
    const messages = await convertToAISDKMessages([
      {
        role: "user",
        timestamp: 1,
        content: [
          { type: "text", text: "inspect" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "image-data" } },
        ],
      },
      {
        role: "assistant",
        timestamp: 2,
        model: model,
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        content: [
          {
            type: "tool_call",
            id: "call-1",
            name: "read_file",
            input: { path: "README.md" },
            providerMetadata: { google: { thoughtSignature: "signature" } },
          },
        ],
      },
      {
        role: "tool_result",
        timestamp: 3,
        toolCallId: "call-1",
        toolName: "read_file",
        output: "contents",
        outputImages: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "tool-image" } }],
        isError: false,
      },
    ]);

    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "file", data: { type: "data", data: "image-data" }, mediaType: "image/png" },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_file",
            input: { path: "README.md" },
            providerOptions: { google: { thoughtSignature: "signature" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            output: {
              type: "content",
              value: [
                { type: "text", text: "contents" },
                {
                  type: "file",
                  data: { type: "data", data: "tool-image" },
                  mediaType: "image/jpeg",
                },
              ],
            },
          },
        ],
      },
    ]);
  });

  it("converts only Diligent function tools and leaves execution to the agent loop", () => {
    const tools = convertToAISDKTools([
      {
        kind: "function",
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      { kind: "provider_builtin", capability: "web" },
    ]);

    expect(Object.keys(tools)).toEqual(["read_file"]);
    expect(tools.read_file).toMatchObject({ description: "Read a file" });
    expect(tools.read_file?.execute).toBeUndefined();
  });
});

describe("AI SDK stream bridge", () => {
  it("allows a provider adapter to remove unsupported temperature sampling", async () => {
    const languageModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "STOP" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      }),
    });
    const createStream = createAISDKStream({
      createLanguageModel: () => languageModel,
      classifyError: (error) =>
        new ProviderError(String(error), { errorType: ProviderErrorType.Unknown, isRetryable: false }),
      resolveTemperature: () => undefined,
    });

    await createStream(
      model,
      { systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] },
      { temperature: 0.2 },
    ).result();

    expect(languageModel.doStreamCalls[0]?.temperature).toBeUndefined();
  });

  it("rejects and closes when the provider emits an abort part", async () => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );
    const parts: AsyncIterable<TextStreamPart<ToolSet>> = (async function* () {
      yield { type: "text-delta", id: "text-1", text: "partial" } as TextStreamPart<ToolSet>;
      yield { type: "abort", reason: "provider cancelled" } as TextStreamPart<ToolSet>;
    })();
    const work = consumeAISDKStreamParts(stream, parts, model, {}, undefined, {}).catch((error) => {
      stream.push({
        type: "error",
        error: new ProviderError(error instanceof Error ? error.message : String(error), {
          errorType: ProviderErrorType.Unknown,
          isRetryable: false,
        }),
      });
    });
    stream.setInnerWork(work);
    const events = [];
    for await (const event of stream) events.push(event);

    await expect(stream.result()).rejects.toThrow("Aborted");
    await stream.waitForInnerWork();
    expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "error"]);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("maps text, reasoning, tool calls, usage, and finish events", async () => {
    const languageModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "reasoning-1" },
            { type: "reasoning-delta", id: "reasoning-1", delta: "think" },
            { type: "reasoning-end", id: "reasoning-1" },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "hello" },
            { type: "text-end", id: "text-1" },
            { type: "tool-input-start", id: "call-1", toolName: "read_file" },
            { type: "tool-input-delta", id: "call-1", delta: '{"path":"README.md"}' },
            { type: "tool-input-end", id: "call-1" },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "read_file",
              input: '{"path":"README.md"}',
              providerMetadata: { adapter: { signature: "sig" } },
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage: {
                inputTokens: { total: 13, noCache: 10, cacheRead: 2, cacheWrite: 1 },
                outputTokens: { total: 5, text: 3, reasoning: 2 },
              },
            },
          ],
        }),
      }),
    });
    const createStream = createAISDKStream({
      createLanguageModel: () => languageModel,
      classifyError: (error) =>
        new ProviderError(String(error), { errorType: ProviderErrorType.Unknown, isRetryable: false }),
    });

    const stream = createStream(
      model,
      {
        systemPrompt: [{ label: "base", content: "system" }],
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        tools: [
          {
            kind: "function",
            name: "read_file",
            description: "Read a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      },
      { maxTokens: 100, temperature: 0.2, effort: "high" },
    );
    const events = [];
    for await (const event of stream) events.push(event);

    expect(events).toEqual([
      { type: "start" },
      { type: "thinking_delta", delta: "think" },
      { type: "thinking_end", thinking: "think" },
      { type: "text_delta", delta: "hello" },
      { type: "text_end", text: "hello" },
      { type: "tool_call_start", id: "call-1", name: "read_file" },
      { type: "tool_call_delta", id: "call-1", delta: '{"path":"README.md"}' },
      { type: "tool_call_end", id: "call-1", name: "read_file", input: { path: "README.md" } },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 } },
      {
        type: "done",
        stopReason: "tool_use",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "think" },
            { type: "text", text: "hello" },
            {
              type: "tool_call",
              id: "call-1",
              name: "read_file",
              input: { path: "README.md" },
              providerMetadata: { adapter: { signature: "sig" } },
            },
          ],
          model: model,
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
          stopReason: "tool_use",
          timestamp: expect.any(Number),
        },
      },
    ]);
    expect(languageModel.doStreamCalls[0]).toMatchObject({
      maxOutputTokens: 100,
      temperature: 0.2,
      reasoning: "high",
    });
  });
});
