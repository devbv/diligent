// @summary Tests assistant request mapping for provider-native built-in web tools
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/agent/agent";
import { EventStream } from "../../src/event-stream";
import type { Model, ProviderEvent, ProviderResult, StreamContext } from "../../src/llm/types";
import type { Tool } from "../../src/tool/types";
import type { AssistantMessage } from "../../src/types";

const TEST_MODEL: Model = {
  modelId: "test-model",
  provider: "anthropic",
  contextWindow: 100_000,
  maxOutputTokens: 4096,
  supportsThinking: false,
};

function makeAssistant(text = "ok"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: TEST_MODEL,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

function makeTool(name: string, modelExposure?: Tool["modelExposure"]): Tool {
  return {
    name,
    description: `${name} description`,
    parameters: z.object({ value: z.string().optional() }),
    modelExposure,
    execute: async () => ({ output: `${name} executed` }),
  };
}

describe("provider builtin tool mapping", () => {
  test("uses explicit provider-native exposure independently of the catalog name", async () => {
    let capturedContext: StreamContext | undefined;

    const agent = new Agent(
      TEST_MODEL,
      [],
      [
        makeTool("web_action"),
        makeTool("browse", {
          kind: "provider_builtin",
          capability: "web",
          options: { citationsEnabled: true },
        }),
      ],
      {
        effort: "medium",
        compaction: { reservePercent: 16 },
        llmMsgStreamFn: (_model, context) => {
          capturedContext = context;
          const stream = new EventStream<ProviderEvent, ProviderResult>(
            (event) => event.type === "done" || event.type === "error",
            (event) => {
              if (event.type === "done") return { message: event.message };
              throw (event as { type: "error"; error: Error }).error;
            },
          );
          queueMicrotask(() => {
            stream.push({ type: "start" });
            stream.push({ type: "done", stopReason: "end_turn", message: makeAssistant() });
          });
          return stream;
        },
      },
    );

    await agent.prompt({ role: "user", content: "hi", timestamp: Date.now() });

    expect(capturedContext?.tools).toEqual([
      {
        kind: "function",
        name: "web_action",
        description: "web_action description",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        kind: "provider_builtin",
        capability: "web",
        options: { citationsEnabled: true },
      },
    ]);
  });

  test("keeps raw inputSchema precedence for ordinary function tools", async () => {
    let capturedContext: StreamContext | undefined;
    const tool: Tool = {
      ...makeTool("schema_tool"),
      inputSchema: {
        type: "object",
        properties: { raw: { type: "number" } },
        required: ["raw"],
      },
    };
    const agent = new Agent(TEST_MODEL, [], [tool], {
      effort: "medium",
      compaction: { reservePercent: 16 },
      llmMsgStreamFn: (_model, context) => {
        capturedContext = context;
        const stream = new EventStream<ProviderEvent, ProviderResult>(
          (event) => event.type === "done" || event.type === "error",
          (event) => {
            if (event.type === "done") return { message: event.message };
            throw (event as { type: "error"; error: Error }).error;
          },
        );
        queueMicrotask(() => {
          stream.push({ type: "start" });
          stream.push({ type: "done", stopReason: "end_turn", message: makeAssistant() });
        });
        return stream;
      },
    });

    await agent.prompt({ role: "user", content: "hi", timestamp: Date.now() });

    expect(capturedContext?.tools).toEqual([
      {
        kind: "function",
        name: "schema_tool",
        description: "schema_tool description",
        inputSchema: {
          type: "object",
          properties: { raw: { type: "number" } },
          required: ["raw"],
        },
      },
    ]);
  });

  test("omits provider-native web declarations when web tools are not present", async () => {
    let capturedContext: StreamContext | undefined;

    const agent = new Agent(TEST_MODEL, [], [makeTool("read")], {
      effort: "medium",
      compaction: { reservePercent: 16 },
      llmMsgStreamFn: (_model, context) => {
        capturedContext = context;
        const stream = new EventStream<ProviderEvent, ProviderResult>(
          (event) => event.type === "done" || event.type === "error",
          (event) => {
            if (event.type === "done") return { message: event.message };
            throw (event as { type: "error"; error: Error }).error;
          },
        );
        queueMicrotask(() => {
          stream.push({ type: "start" });
          stream.push({ type: "done", stopReason: "end_turn", message: makeAssistant() });
        });
        return stream;
      },
    });

    await agent.prompt({ role: "user", content: "hi", timestamp: Date.now() });

    expect(capturedContext?.tools).toEqual([
      {
        kind: "function",
        name: "read",
        description: "read description",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          additionalProperties: false,
        },
      },
    ]);
  });
});
