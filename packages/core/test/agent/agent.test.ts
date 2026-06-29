// @summary Unit tests for Agent class — subscribe()+prompt() yields turn events
import { describe, expect, test } from "bun:test";
import type { CoreAgentEvent } from "@diligent/core/agent";
import { Agent } from "@diligent/core/agent";
import { EventStream } from "@diligent/core/event-stream";
import type { Model, ProviderEvent, ProviderResult, ToolDefinition } from "@diligent/core/llm/types";
import { CONTEXT_OVERFLOW_ERROR_MESSAGE, ProviderError } from "@diligent/core/llm/types";
import type { AssistantMessage } from "@diligent/core/types";
import { z } from "zod";

const TEST_MODEL: Model = {
  id: "test-model",
  provider: "test",
  contextWindow: 100_000,
  maxOutputTokens: 4096,
  supportsThinking: false,
};

function makeAssistant(text = "ok"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: TEST_MODEL.id,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

const BASE_CONFIG = {
  systemPrompt: [] as { label: string; content: string }[],
  tools: [] as never[],
  effort: "medium" as const,
  compaction: { reservePercent: 16, keepRecentTokens: 20_000 },
};

function makeStreamFn(response: AssistantMessage) {
  return () => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );
    queueMicrotask(() => {
      stream.push({ type: "start" });
      stream.push({ type: "text_delta", delta: response.content[0]?.type === "text" ? response.content[0].text : "" });
      stream.push({ type: "done", stopReason: response.stopReason, message: response });
    });
    return stream;
  };
}

describe("Agent", () => {
  test("prompt() yields turn events via subscribe()", async () => {
    const agent = new Agent(TEST_MODEL, [{ label: "test", content: "be helpful" }], BASE_CONFIG.tools, {
      effort: BASE_CONFIG.effort,
      compaction: BASE_CONFIG.compaction,
      llmMsgStreamFn: makeStreamFn(makeAssistant("hello")),
    });

    const events: CoreAgentEvent[] = [];
    const unsub = agent.subscribe((e) => events.push(e));
    await agent.prompt({ role: "user", content: "hi", timestamp: Date.now() });
    unsub();

    expect(events.some((e) => e.type === "turn_start")).toBe(true);
    expect(events.some((e) => e.type === "turn_end")).toBe(true);
    expect(events.some((e) => e.type === "message_end")).toBe(true);
  });

  test("prompt() resolves to final message list", async () => {
    const response = makeAssistant("result text");
    const agent = new Agent(TEST_MODEL, [{ label: "test", content: "be helpful" }], BASE_CONFIG.tools, {
      effort: BASE_CONFIG.effort,
      compaction: BASE_CONFIG.compaction,
      llmMsgStreamFn: makeStreamFn(response),
    });

    const messages = await agent.prompt({ role: "user", content: "ask", timestamp: Date.now() });

    expect(messages.length).toBeGreaterThanOrEqual(2); // user + assistant
    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
  });

  test("prompt() does not commit user message when the loop fails", async () => {
    const restoredMessage = { role: "user", content: "existing", timestamp: Date.now() } as const;
    const agent = new Agent(TEST_MODEL, BASE_CONFIG.systemPrompt, BASE_CONFIG.tools, {
      effort: BASE_CONFIG.effort,
      compaction: BASE_CONFIG.compaction,
      llmMsgStreamFn: () => {
        throw new Error("provider failed before producing a response");
      },
    });
    agent.restore([restoredMessage]);

    await expect(agent.prompt({ role: "user", content: "new", timestamp: Date.now() })).rejects.toThrow(
      "provider failed before producing a response",
    );

    expect(agent.getMessages()).toEqual([restoredMessage]);
  });

  test("prompt() passes signal to streamFunction", async () => {
    let capturedSignal: AbortSignal | undefined;
    const response = makeAssistant();
    const agent = new Agent(TEST_MODEL, BASE_CONFIG.systemPrompt, BASE_CONFIG.tools, {
      effort: BASE_CONFIG.effort,
      compaction: BASE_CONFIG.compaction,
      llmMsgStreamFn: (_model: Model, _ctx: unknown, opts: { signal?: AbortSignal }) => {
        capturedSignal = opts?.signal;
        return makeStreamFn(response)();
      },
    });

    const controller = new AbortController();
    await agent.prompt({ role: "user", content: "hi", timestamp: Date.now() }, controller.signal);

    expect(capturedSignal).toBeDefined();
    // The loop wraps the user signal with AbortSignal.any(), so aborting the user controller aborts the captured signal too
    expect(capturedSignal!.aborted).toBe(false);
    controller.abort();
    expect(capturedSignal!.aborted).toBe(true);
  });

  test("config is readable; setters update config", async () => {
    const agent = new Agent(TEST_MODEL, BASE_CONFIG.systemPrompt, BASE_CONFIG.tools, {
      effort: BASE_CONFIG.effort,
      compaction: BASE_CONFIG.compaction,
      llmMsgStreamFn: makeStreamFn(makeAssistant("response")),
    });

    expect(agent.effort).toBe("medium");
    agent.setEffort("high");
    expect(agent.effort).toBe("high");
  });

  test("steer() and hasPendingMessages() work correctly", () => {
    const agent = new Agent(TEST_MODEL, BASE_CONFIG.systemPrompt, BASE_CONFIG.tools, {
      effort: BASE_CONFIG.effort,
      compaction: BASE_CONFIG.compaction,
      llmMsgStreamFn: makeStreamFn(makeAssistant()),
    });

    expect(agent.hasPendingMessages()).toBe(false);
    agent.steer({ role: "user", content: "redirect", timestamp: Date.now() });
    expect(agent.hasPendingMessages()).toBe(true);
    agent.drainPendingMessages();
    expect(agent.hasPendingMessages()).toBe(false);
  });

  test("event ordering stays lifecycle-safe", async () => {
    const agent = new Agent(TEST_MODEL, BASE_CONFIG.systemPrompt, BASE_CONFIG.tools, {
      effort: BASE_CONFIG.effort,
      compaction: BASE_CONFIG.compaction,
      llmMsgStreamFn: makeStreamFn(makeAssistant("ordered")),
    });

    const events: CoreAgentEvent[] = [];
    const unsub = agent.subscribe((event) => events.push(event));
    await agent.prompt({ role: "user", content: "hi", timestamp: Date.now() });
    unsub();

    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "turn_start",
      "prompt_signature",
      "message_start",
      "message_delta",
      "message_end",
      "usage",
      "turn_end",
      "agent_end",
    ]);
  });

  test("tool-only responses still emit message_start before message_end", async () => {
    let callCount = 0;
    const agent = new Agent(
      TEST_MODEL,
      BASE_CONFIG.systemPrompt,
      [
        {
          name: "echo",
          description: "Echo",
          parameters: z.object({ message: z.string() }),
          async execute() {
            return { output: "hi" };
          },
        },
      ],
      {
        effort: BASE_CONFIG.effort,
        compaction: BASE_CONFIG.compaction,
        llmMsgStreamFn: () => {
          const stream = new EventStream<ProviderEvent, ProviderResult>(
            (event) => event.type === "done" || event.type === "error",
            (event) => {
              if (event.type === "done") return { message: event.message };
              throw (event as { type: "error"; error: Error }).error;
            },
          );

          queueMicrotask(() => {
            stream.push({ type: "start" });
            if (callCount++ === 0) {
              stream.push({ type: "tool_call_start", id: "tc_1", name: "echo" });
              stream.push({ type: "tool_call_end", id: "tc_1", name: "echo", input: { message: "hi" } });
              stream.push({
                type: "done",
                stopReason: "tool_use",
                message: {
                  role: "assistant",
                  content: [{ type: "tool_call", id: "tc_1", name: "echo", input: { message: "hi" } }],
                  model: TEST_MODEL.id,
                  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                  stopReason: "tool_use",
                  timestamp: Date.now(),
                },
              });
              return;
            }
            stream.push({ type: "text_delta", delta: "done" });
            stream.push({ type: "done", stopReason: "end_turn", message: makeAssistant("done") });
          });
          return stream;
        },
      },
    );

    const events: CoreAgentEvent[] = [];
    const unsub = agent.subscribe((event) => events.push(event));
    await agent.prompt({ role: "user", content: "hi", timestamp: Date.now() });
    unsub();

    const types = events.map((event) => event.type);
    expect(types.indexOf("message_start")).toBeLessThan(types.indexOf("message_end"));
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
  });

  test("abort emits agent_end once and no fatal error event", async () => {
    const agent = new Agent(TEST_MODEL, BASE_CONFIG.systemPrompt, BASE_CONFIG.tools, {
      effort: BASE_CONFIG.effort,
      compaction: BASE_CONFIG.compaction,
      llmMsgStreamFn: () => {
        const stream = new EventStream<ProviderEvent, ProviderResult>(
          (event) => event.type === "done" || event.type === "error",
          (event) => {
            if (event.type === "done") return { message: event.message };
            throw (event as { type: "error"; error: Error }).error;
          },
        );

        setTimeout(() => stream.end({ message: makeAssistant("aborted") }), 20);
        return stream;
      },
    });

    const events: CoreAgentEvent[] = [];
    const unsub = agent.subscribe((event) => events.push(event));
    const controller = new AbortController();
    const run = agent.prompt({ role: "user", content: "hi", timestamp: Date.now() }, controller.signal);
    controller.abort();
    await run;
    unsub();

    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("provider stream missing terminal event raises fatal error", async () => {
    const agent = new Agent(TEST_MODEL, BASE_CONFIG.systemPrompt, BASE_CONFIG.tools, {
      effort: BASE_CONFIG.effort,
      compaction: BASE_CONFIG.compaction,
      llmMsgStreamFn: () => {
        const stream = new EventStream<ProviderEvent, ProviderResult>(
          (event) => event.type === "done" || event.type === "error",
          (event) => {
            if (event.type === "done") return { message: event.message };
            throw (event as { type: "error"; error: Error }).error;
          },
        );

        queueMicrotask(() => stream.end({ message: makeAssistant("missing done") }));
        return stream;
      },
    });

    const events: CoreAgentEvent[] = [];
    const unsub = agent.subscribe((event) => events.push(event));

    await expect(agent.prompt({ role: "user", content: "hi", timestamp: Date.now() })).rejects.toThrow(
      "Provider stream ended without producing a terminal event",
    );

    unsub();
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent?.type).toBe("error");
    if (errorEvent?.type === "error") {
      expect(errorEvent.error.message).toBe("Provider stream ended without producing a terminal event");
    }
  });

  test("provider errors retain classification in fatal error events", async () => {
    const agent = new Agent(TEST_MODEL, BASE_CONFIG.systemPrompt, BASE_CONFIG.tools, {
      effort: BASE_CONFIG.effort,
      compaction: BASE_CONFIG.compaction,
      llmMsgStreamFn: () => {
        const stream = new EventStream<ProviderEvent, ProviderResult>(
          (event) => event.type === "done" || event.type === "error",
          (event) => {
            if (event.type === "done") return { message: event.message };
            throw (event as { type: "error"; error: Error }).error;
          },
        );

        queueMicrotask(() =>
          stream.push({
            type: "error",
            error: new ProviderError(CONTEXT_OVERFLOW_ERROR_MESSAGE, "context_overflow", false, undefined, 400),
          }),
        );
        return stream;
      },
    });

    const events: CoreAgentEvent[] = [];
    const unsub = agent.subscribe((event) => events.push(event));

    await expect(agent.prompt({ role: "user", content: "hi", timestamp: Date.now() })).rejects.toThrow(
      CONTEXT_OVERFLOW_ERROR_MESSAGE,
    );

    unsub();
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent?.type).toBe("error");
    if (errorEvent?.type === "error") {
      expect(errorEvent.error.message).toBe(CONTEXT_OVERFLOW_ERROR_MESSAGE);
      expect(errorEvent.error.providerErrorType).toBe("context_overflow");
      expect(errorEvent.error.statusCode).toBe(400);
      expect(errorEvent.error.isRetryable).toBe(false);
    }
  });

  test("provider-native web tools are passed as normalized provider built-ins", async () => {
    let capturedTools: ToolDefinition[] = [];
    const agent = new Agent(
      TEST_MODEL,
      BASE_CONFIG.systemPrompt,
      [
        {
          name: "web_action",
          description: "Use the web",
          parameters: z.object({ url: z.string().url(), prompt: z.string().optional() }),
          async execute() {
            return { output: "unused" };
          },
        },
        {
          name: "read",
          description: "Read a file",
          parameters: z.object({ filePath: z.string() }),
          async execute() {
            return { output: "unused" };
          },
        },
      ],
      {
        effort: BASE_CONFIG.effort,
        compaction: BASE_CONFIG.compaction,
        llmMsgStreamFn: (_model: Model, ctx: { tools: ToolDefinition[] }) => {
          capturedTools = ctx.tools;
          return makeStreamFn(makeAssistant("ok"))();
        },
      },
    );

    await agent.prompt({ role: "user", content: "hi", timestamp: Date.now() });

    expect(capturedTools).toEqual([
      { kind: "provider_builtin", capability: "web", options: { citationsEnabled: true } },
      {
        kind: "function",
        name: "read",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
          },
          required: ["filePath"],
          additionalProperties: false,
        },
      },
    ]);
  });

  test("provider-native web tools are absent when not provided to the agent", async () => {
    let capturedTools: ToolDefinition[] = [];
    const agent = new Agent(
      TEST_MODEL,
      BASE_CONFIG.systemPrompt,
      [
        {
          name: "read",
          description: "Read a file",
          parameters: z.object({ filePath: z.string() }),
          async execute() {
            return { output: "unused" };
          },
        },
      ],
      {
        effort: BASE_CONFIG.effort,
        compaction: BASE_CONFIG.compaction,
        llmMsgStreamFn: (_model: Model, ctx: { tools: ToolDefinition[] }) => {
          capturedTools = ctx.tools;
          return makeStreamFn(makeAssistant("ok"))();
        },
      },
    );

    await agent.prompt({ role: "user", content: "hi", timestamp: Date.now() });

    expect(capturedTools).toEqual([
      {
        kind: "function",
        name: "read",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
          },
          required: ["filePath"],
          additionalProperties: false,
        },
      },
    ]);
  });
});
