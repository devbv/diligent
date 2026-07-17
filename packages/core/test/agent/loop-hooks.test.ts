// @summary Contract tests for synchronous Agent-scoped loop hooks

import { describe, expect, test } from "bun:test";
import type { AgentLoopHook, CoreAgentEvent } from "@diligent/core/agent";
import { Agent } from "@diligent/core/agent";
import { EventStream } from "@diligent/core/event-stream";
import type { AssistantMessage, Message } from "@diligent/core/message-contract";
import type {
  Model,
  ProviderEvent,
  ProviderResult,
  StreamContext,
  StreamFunction,
} from "@diligent/core/provider-contract";
import { createLogger, type LogRecord } from "@diligent/logging";
import { z } from "zod";

const model: Model = {
  modelId: "test-model",
  provider: "anthropic",
  contextWindow: 100_000,
  maxOutputTokens: 4_096,
  supportsThinking: false,
};
const user = (content = "goal"): Message => ({ role: "user", content, timestamp: Date.now() });

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: model,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason,
    timestamp: Date.now(),
  };
}

function streamFor(responses: AssistantMessage[]): StreamFunction & { contexts: StreamContext[] } {
  let index = 0;
  const contexts: StreamContext[] = [];
  const fn: StreamFunction = (_model, context) => {
    contexts.push({ ...context, messages: [...context.messages] });
    const response = responses[index++];
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );
    queueMicrotask(() => {
      stream.push({ type: "start" });
      for (const block of response.content) {
        if (block.type === "text") stream.push({ type: "text_delta", delta: block.text });
        if (block.type === "tool_call") {
          stream.push({ type: "tool_call_start", id: block.id, name: block.name });
          stream.push({ type: "tool_call_end", id: block.id, name: block.name, input: block.input });
        }
      }
      stream.push({ type: "done", stopReason: response.stopReason, message: response });
    });
    return stream;
  };
  return Object.assign(fn, { contexts });
}

function makeAgent(stream: StreamFunction, hooks: readonly AgentLoopHook[], records?: LogRecord[]): Agent {
  return new Agent(
    model,
    [],
    [
      {
        name: "echo",
        description: "echo",
        parameters: z.object({}),
        async execute() {
          return { output: "ok" };
        },
      },
    ],
    {
      llmMsgStreamFn: stream,
      loopHooks: hooks,
      ...(records
        ? {
            logger: createLogger({
              scope: "test",
              sink: (record) => {
                records.push(record);
              },
            }),
          }
        : {}),
    },
  );
}

describe("Agent loop hooks", () => {
  test("restores on each restore API and prompt start sees the outer user message", async () => {
    const calls: string[] = [];
    const hook: AgentLoopHook = {
      id: "recording",
      restore: ({ messages }) => calls.push(`restore:${messages.length}`),
      onPromptStart: ({ messages }) => calls.push(`prompt:${messages.at(-1)?.role}`),
    };
    const stream = streamFor([assistant([{ type: "text", text: "ok" }], "end_turn")]);
    const agent = makeAgent(stream, [hook]);
    agent.restore([user("one")]);
    agent.restoreCompactionState([user("one"), user("two")], { state: true });
    await agent.prompt(user("three"));
    expect(calls).toEqual(["restore:1", "restore:2", "prompt:user"]);
  });

  test("runs in registration order, injects in returned order, and emits one structured event", async () => {
    const order: string[] = [];
    const hooks: AgentLoopHook[] = ["a", "b"].map((id) => ({
      id,
      beforeTurn() {
        order.push(id);
        return [{ source: id, content: `injected-${id}`, metadata: { order: id } }];
      },
    }));
    const stream = streamFor([assistant([{ type: "text", text: "ok" }], "end_turn")]);
    const agent = makeAgent(stream, hooks);
    const events: CoreAgentEvent[] = [];
    agent.subscribe((event) => events.push(event));
    await agent.prompt(user());

    expect(order).toEqual(["a", "b"]);
    expect(
      stream.contexts[0].messages.slice(1, 3).map((message) => message.role === "user" && message.content),
    ).toEqual(["injected-a", "injected-b"]);
    const injected = events.filter((event) => event.type === "context_injected");
    expect(injected).toHaveLength(1);
    expect(injected[0]?.type === "context_injected" && injected[0].injections.map(({ source }) => source)).toEqual([
      "a",
      "b",
    ]);
    expect(injected[0]?.type === "context_injected" && injected[0].injections.map(({ metadata }) => metadata)).toEqual([
      { order: "a" },
      { order: "b" },
    ]);
  });

  test("observes tool results and afterTurn immediately before turn_end across prompts", async () => {
    const phases: string[] = [];
    const hook: AgentLoopHook = {
      id: "lifecycle",
      onToolResult: ({ result }) => phases.push(`result:${result.output}`),
      afterTurn: ({ toolResults }) => phases.push(`after:${toolResults.length}`),
    };
    const stream = streamFor([
      assistant([{ type: "tool_call", id: "tc1", name: "echo", input: {} }], "tool_use"),
      assistant([{ type: "text", text: "done" }], "end_turn"),
      assistant([{ type: "text", text: "again" }], "end_turn"),
    ]);
    const agent = makeAgent(stream, [hook]);
    agent.subscribe((event) => {
      if (event.type === "turn_end") phases.push("event:turn_end");
    });
    await agent.prompt(user());
    await agent.prompt(user("second"));
    expect(phases).toEqual([
      "result:ok",
      "after:1",
      "event:turn_end",
      "after:0",
      "event:turn_end",
      "after:0",
      "event:turn_end",
    ]);
  });

  test("rejects duplicate ids at construction", () => {
    const stream = streamFor([assistant([{ type: "text", text: "ok" }], "end_turn")]);
    expect(() => makeAgent(stream, [{ id: "same" }, { id: "same" }])).toThrow("Duplicate agent loop hook id: same");
  });

  test("logs, disables, and isolates a throwing hook for the Agent lifetime", async () => {
    let failingCalls = 0;
    let healthyCalls = 0;
    const records: LogRecord[] = [];
    const stream = streamFor([
      assistant([{ type: "text", text: "first" }], "end_turn"),
      assistant([{ type: "text", text: "second" }], "end_turn"),
    ]);
    const agent = makeAgent(
      stream,
      [
        {
          id: "failing",
          beforeTurn() {
            failingCalls++;
            throw new Error("boom");
          },
        },
        { id: "healthy", beforeTurn: () => void healthyCalls++ },
      ],
      records,
    );
    await agent.prompt(user());
    await agent.prompt(user("again"));
    expect(failingCalls).toBe(1);
    expect(healthyCalls).toBe(2);
    expect(records.some((record) => record.event === "agent_loop_hook_disabled")).toBe(true);
  });
});
