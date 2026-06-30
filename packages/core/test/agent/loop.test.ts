// @summary Tests for core agent loop execution and tool calling (via Agent.subscribe+prompt)
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/agent/agent";
import type { CoreAgentEvent } from "../../src/agent/types";
import { EventStream } from "../../src/event-stream";
import { NATIVE_COMPACTION_MIN_INPUT_TOKENS } from "../../src/llm/compaction";
import type { NativeCompactFn, NativeCompactionInput } from "../../src/llm/provider/native-compaction";
import type {
  Model,
  ProviderEvent,
  ProviderResult,
  StreamContext,
  StreamFunction,
  StreamOptions,
} from "../../src/llm/types";
import { ProviderError } from "../../src/llm/types";
import type { Tool } from "../../src/tool/types";
import type { AssistantMessage, Message } from "../../src/types";

const TEST_MODEL: Model = {
  id: "test-model",
  provider: "test",
  contextWindow: 100_000,
  maxOutputTokens: 4096,
};

function makeAssistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "end_turn",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: TEST_MODEL.id,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason,
    timestamp: Date.now(),
  };
}

function createMockStreamFunction(
  responses: AssistantMessage[],
): StreamFunction & { contexts: StreamContext[]; options: StreamOptions[] } {
  let callIndex = 0;
  const contexts: StreamContext[] = [];
  const options: StreamOptions[] = [];

  const fn: StreamFunction = (_model, context, streamOptions) => {
    contexts.push(context);
    options.push(streamOptions);
    const msg = responses[callIndex++];
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );

    setTimeout(() => {
      stream.push({ type: "start" });
      for (const block of msg.content) {
        if (block.type === "text") {
          stream.push({ type: "text_delta", delta: block.text });
          stream.push({ type: "text_end", text: block.text });
        } else if (block.type === "tool_call") {
          stream.push({ type: "tool_call_start", id: block.id, name: block.name });
          stream.push({
            type: "tool_call_end",
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }
      stream.push({ type: "done", stopReason: msg.stopReason, message: msg });
    }, 0);

    return stream;
  };

  return Object.assign(fn, { contexts, options });
}

const echoTool: Tool = {
  name: "echo",
  description: "Echo a message",
  parameters: z.object({ message: z.string() }),
  async execute(args: { message: string }) {
    return { output: args.message };
  },
};

/** A read-only tool that supports parallel execution and records timing */
function createParallelTool(name: string, delayMs = 50): Tool & { calls: number[] } {
  const calls: number[] = [];
  return {
    name,
    description: `Parallel tool ${name}`,
    parameters: z.object({ query: z.string() }),
    supportParallel: true,
    async execute(args: { query: string }) {
      const start = Date.now();
      calls.push(start);
      await new Promise((r) => setTimeout(r, delayMs));
      return { output: `${name}:${args.query}` };
    },
    calls,
  };
}

function createParallelAbortTool(name: string): Tool {
  return {
    name,
    description: `Aborting parallel tool ${name}`,
    parameters: z.object({ query: z.string() }),
    supportParallel: true,
    async execute(args: { query: string }) {
      return { output: `${name}:${args.query}`, abortRequested: true };
    },
  };
}

/** A sequential tool (no supportParallel flag) */
const sequentialTool: Tool = {
  name: "seq_tool",
  description: "Sequential tool",
  parameters: z.object({ data: z.string() }),
  async execute(args: { data: string }) {
    return { output: `seq:${args.data}` };
  },
};

/** Helper: run agent with a single user message and collect events */
async function runAgent(
  agent: Agent,
  userMessage: Message,
  opts?: Parameters<Agent["prompt"]>[1],
): Promise<{ events: CoreAgentEvent[]; result: Message[] }> {
  const events: CoreAgentEvent[] = [];
  const unsub = agent.subscribe((e) => events.push(e));
  const result = await agent.prompt(userMessage, opts);
  unsub();
  return { events, result };
}

describe("Agent loop", () => {
  test("text-only response: single turn", async () => {
    const msg = makeAssistant([{ type: "text", text: "Hello!" }]);
    const streamFn = createMockStreamFunction([msg]);

    const agent = new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [], {
      effort: "medium",
      llmMsgStreamFn: streamFn,
    });

    const { events, result } = await runAgent(agent, { role: "user", content: "hi", timestamp: Date.now() });

    const types = events.map((e) => e.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("turn_start");
    expect(types).toContain("message_start");
    expect(types).toContain("message_end");
    expect(types).toContain("turn_end");
    expect(types).toContain("agent_end");

    expect(result.length).toBeGreaterThan(1); // user + assistant
  });

  test("tool call: two turns (LLM → tool → LLM → response)", async () => {
    const toolCallMsg = makeAssistant(
      [{ type: "tool_call", id: "tc_1", name: "echo", input: { message: "hello" } }],
      "tool_use",
    );
    const responseMsg = makeAssistant([{ type: "text", text: "The echo returned: hello" }]);
    const streamFn = createMockStreamFunction([toolCallMsg, responseMsg]);

    const agent = new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [echoTool], {
      effort: "medium",
      llmMsgStreamFn: streamFn,
    });

    const { events } = await runAgent(agent, { role: "user", content: "echo hello", timestamp: Date.now() });

    const types = events.map((e) => e.type);
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");

    expect(types.filter((t) => t === "turn_start")).toHaveLength(2);

    const toolEnd = events.find((e) => e.type === "tool_end") as Extract<CoreAgentEvent, { type: "tool_end" }>;
    expect(toolEnd.toolName).toBe("echo");
    expect(toolEnd.output).toBe("hello");

    expect(streamFn.contexts.length).toBeGreaterThanOrEqual(1);
    const tools = streamFn.contexts[0].tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("echo");
    expect(tools[0].description).toBe("Echo a message");
    expect(tools[0].inputSchema).toHaveProperty("properties");
    expect((tools[0].inputSchema as Record<string, unknown>).properties).toHaveProperty("message");
  });

  test("tool schemas: Zod types converted to valid JSON Schema in StreamContext", async () => {
    const complexTool: Tool = {
      name: "complex",
      description: "Tool with diverse param types",
      parameters: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional().describe("Max results"),
        recursive: z.boolean().describe("Recurse into subdirs"),
        extensions: z.array(z.string()).describe("File extensions"),
        mode: z.enum(["exact", "fuzzy", "regex"]).describe("Match mode"),
      }),
      async execute() {
        return { output: "ok" };
      },
    };

    const msg = makeAssistant([{ type: "text", text: "done" }]);
    const streamFn = createMockStreamFunction([msg]);

    const agent = new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [complexTool], {
      effort: "medium",
      llmMsgStreamFn: streamFn,
    });

    await runAgent(agent, { role: "user", content: "test", timestamp: Date.now() });

    const tools = streamFn.contexts[0].tools;
    expect(tools).toHaveLength(1);

    const schema = tools[0].inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const required = schema.required as string[];

    expect(required).toContain("query");
    expect(required).toContain("recursive");
    expect(required).toContain("extensions");
    expect(required).toContain("mode");
    expect(required).not.toContain("limit");

    expect(props.query.type).toBe("string");
    expect(props.limit.type).toBe("number");
    expect(props.recursive.type).toBe("boolean");
    expect(props.extensions.type).toBe("array");
    expect(props.mode).toHaveProperty("enum");
    expect(props.mode.enum as string[]).toEqual(["exact", "fuzzy", "regex"]);

    expect(props.query.description).toBe("Search query");
    expect(props.extensions.description).toBe("File extensions");
  });

  test("unknown tool: error result fed back to LLM", async () => {
    const toolCallMsg = makeAssistant([{ type: "tool_call", id: "tc_1", name: "nonexistent", input: {} }], "tool_use");
    const responseMsg = makeAssistant([{ type: "text", text: "Sorry, that tool doesn't exist" }]);
    const streamFn = createMockStreamFunction([toolCallMsg, responseMsg]);

    const agent = new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [echoTool], {
      effort: "medium",
      llmMsgStreamFn: streamFn,
    });

    const { events } = await runAgent(agent, { role: "user", content: "use fake tool", timestamp: Date.now() });

    const toolEnd = events.find((e) => e.type === "tool_end") as Extract<CoreAgentEvent, { type: "tool_end" }>;
    expect(toolEnd.isError).toBe(true);
    expect(toolEnd.output).toContain("Unknown tool");
  });

  test("parallel tools: all supportParallel=true → parallel execution (all tool_start before tool_end)", async () => {
    const toolA = createParallelTool("ptool_a", 50);
    const toolB = createParallelTool("ptool_b", 50);

    const toolCallMsg = makeAssistant(
      [
        { type: "tool_call", id: "tc_1", name: "ptool_a", input: { query: "hello" } },
        { type: "tool_call", id: "tc_2", name: "ptool_b", input: { query: "world" } },
      ],
      "tool_use",
    );
    const responseMsg = makeAssistant([{ type: "text", text: "done" }]);
    const streamFn = createMockStreamFunction([toolCallMsg, responseMsg]);

    const agent = new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [toolA, toolB], {
      effort: "medium",
      llmMsgStreamFn: streamFn,
    });

    const { events } = await runAgent(agent, { role: "user", content: "go", timestamp: Date.now() });

    const types = events.map((e) => e.type);
    const firstToolEnd = types.indexOf("tool_end");
    const toolStarts = types.filter((t) => t === "tool_start");
    const toolStartIndices: number[] = [];
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "tool_start") toolStartIndices.push(i);
    }

    expect(toolStarts).toHaveLength(2);
    expect(toolStartIndices.every((idx) => idx < firstToolEnd)).toBe(true);

    expect(toolA.calls).toHaveLength(1);
    expect(toolB.calls).toHaveLength(1);
    const timeDiff = Math.abs(toolA.calls[0] - toolB.calls[0]);
    expect(timeDiff).toBeLessThan(30);
  });

  test("mixed tools: sequential + parallel → sequential fallback", async () => {
    const toolA = createParallelTool("ptool_a", 50);

    const toolCallMsg = makeAssistant(
      [
        { type: "tool_call", id: "tc_1", name: "ptool_a", input: { query: "hello" } },
        { type: "tool_call", id: "tc_2", name: "seq_tool", input: { data: "world" } },
      ],
      "tool_use",
    );
    const responseMsg = makeAssistant([{ type: "text", text: "done" }]);
    const streamFn = createMockStreamFunction([toolCallMsg, responseMsg]);

    const agent = new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [toolA, sequentialTool], {
      effort: "medium",
      llmMsgStreamFn: streamFn,
    });

    const { events } = await runAgent(agent, { role: "user", content: "go", timestamp: Date.now() });

    const types = events.map((e) => e.type);
    const toolEvents = types.filter((t) => t === "tool_start" || t === "tool_end");
    expect(toolEvents).toEqual(["tool_start", "tool_end", "tool_start", "tool_end"]);
  });

  test("single parallel tool: no parallel path (length must be > 1)", async () => {
    const toolA = createParallelTool("ptool_a", 10);

    const toolCallMsg = makeAssistant(
      [{ type: "tool_call", id: "tc_1", name: "ptool_a", input: { query: "solo" } }],
      "tool_use",
    );
    const responseMsg = makeAssistant([{ type: "text", text: "done" }]);
    const streamFn = createMockStreamFunction([toolCallMsg, responseMsg]);

    const agent = new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [toolA], {
      effort: "medium",
      llmMsgStreamFn: streamFn,
    });

    const { events } = await runAgent(agent, { role: "user", content: "go", timestamp: Date.now() });

    const toolEnds = events.filter((e) => e.type === "tool_end") as Extract<CoreAgentEvent, { type: "tool_end" }>[];
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0].output).toBe("ptool_a:solo");
  });

  test("tool without supportParallel flag: treated as sequential (default false)", async () => {
    const toolCallMsg = makeAssistant(
      [
        { type: "tool_call", id: "tc_1", name: "echo", input: { message: "a" } },
        { type: "tool_call", id: "tc_2", name: "echo", input: { message: "b" } },
      ],
      "tool_use",
    );
    const responseMsg = makeAssistant([{ type: "text", text: "done" }]);
    const streamFn = createMockStreamFunction([toolCallMsg, responseMsg]);

    const agent = new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [echoTool], {
      effort: "medium",
      llmMsgStreamFn: streamFn,
    });

    const { events } = await runAgent(agent, { role: "user", content: "go", timestamp: Date.now() });

    const types = events.map((e) => e.type);
    const toolEvents = types.filter((t) => t === "tool_start" || t === "tool_end");
    expect(toolEvents).toEqual(["tool_start", "tool_end", "tool_start", "tool_end"]);
  });

  test("parallel abort request stops after first emitted result", async () => {
    const abortTool = createParallelAbortTool("abort_tool");
    const toolB = createParallelTool("ptool_b", 10);

    const toolCallMsg = makeAssistant(
      [
        { type: "tool_call", id: "tc_1", name: "abort_tool", input: { query: "stop" } },
        { type: "tool_call", id: "tc_2", name: "ptool_b", input: { query: "later" } },
      ],
      "tool_use",
    );
    const streamFn = createMockStreamFunction([toolCallMsg]);

    const agent = new Agent(TEST_MODEL, [{ label: "test", content: "test" }], [abortTool, toolB], {
      effort: "medium",
      llmMsgStreamFn: streamFn,
    });

    const { events, result } = await runAgent(agent, { role: "user", content: "go", timestamp: Date.now() });

    expect(events.filter((event) => event.type === "turn_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_start")).toHaveLength(2);
    expect(events.filter((event) => event.type === "tool_end")).toHaveLength(1);
    expect(result.filter((message) => message.role === "tool_result")).toHaveLength(0);
  });
});

describe("Agent compactionSummary persistence", () => {
  test("prompt() persists compactionSummary produced by auto-compaction across calls", async () => {
    const compactionSummary = { type: "compaction", encrypted_content: "opaque-blob" };

    const nativeCompactFn: NativeCompactFn = async (_input: NativeCompactionInput) => ({
      status: "ok",
      summary: "compacted",
      compactionSummary,
    });

    // contextWindow=100, reservePercent=90 → threshold=10 tokens
    // The assistant mock returns usage={inputTokens:10, outputTokens:5, ...} = 15 total,
    // which exceeds the threshold on the second prompt call, triggering auto-compaction.
    const smallModel: Model = {
      id: "test-model",
      provider: "test",
      contextWindow: 200_000,
      maxOutputTokens: 4096,
    };

    const assistantMsg = makeAssistant([{ type: "text", text: "ok" }]);
    const streamFn = createMockStreamFunction([assistantMsg, assistantMsg]);

    const agent = new Agent(smallModel, [{ label: "sys", content: "sys" }], [], {
      effort: "medium",
      llmMsgStreamFn: streamFn,
      llmCompactionFn: nativeCompactFn,
      compaction: { reservePercent: 70, keepRecentTokens: 0 },
    });

    const bigContent = "x".repeat(200_001);
    const userMsg = (text: string): Message => ({ role: "user", content: text + bigContent, timestamp: Date.now() });

    // First prompt: no compaction (first turn, not enough history)
    await agent.prompt(userMsg("first"));
    const summaryAfterFirst = (agent as unknown as { compactionSummary?: Record<string, unknown> }).compactionSummary;
    expect(summaryAfterFirst).toBeUndefined();

    // Second prompt: total messages (~100k tokens) exceed threshold (60k = 200k × 0.3)
    // Auto-compaction fires and the returned compactionSummary must be persisted on the Agent.
    await agent.prompt(userMsg("second"));
    const summaryAfterSecond = (agent as unknown as { compactionSummary?: Record<string, unknown> }).compactionSummary;

    expect(summaryAfterSecond).toEqual(compactionSummary);
  });
});

describe("Agent context overflow compaction", () => {
  function createContextOverflowStream(
    failuresBeforeSuccess: number,
  ): StreamFunction & { callCount: () => number; contexts: StreamContext[] } {
    let calls = 0;
    const contexts: StreamContext[] = [];
    const streamFn: StreamFunction = (_model, context, _options) => {
      calls++;
      contexts.push(context);
      const stream = new EventStream<ProviderEvent, ProviderResult>(
        (event) => event.type === "done" || event.type === "error",
        (event) => {
          if (event.type === "done") return { message: event.message };
          throw (event as { type: "error"; error: Error }).error;
        },
      );
      stream.result().catch(() => {});

      setTimeout(() => {
        stream.push({ type: "start" });
        if (calls <= failuresBeforeSuccess) {
          stream.push({
            type: "error",
            error: new ProviderError("Context overflow", "context_overflow", false),
          });
          return;
        }
        const message = makeAssistant([{ type: "text", text: "recovered" }]);
        stream.push({ type: "done", stopReason: "end_turn", message });
      }, 0);

      return stream;
    };

    return Object.assign(streamFn, { callCount: () => calls, contexts });
  }

  test("forces compaction and retries once on provider context_overflow", async () => {
    let compactCalls = 0;
    const nativeCompactFn: NativeCompactFn = async (_input: NativeCompactionInput) => {
      compactCalls++;
      return { status: "ok", summary: "forced summary" };
    };
    const streamFn = createContextOverflowStream(1);
    const agent = new Agent(TEST_MODEL, [{ label: "sys", content: "sys" }], [], {
      effort: "medium",
      llmMsgStreamFn: streamFn,
      llmCompactionFn: nativeCompactFn,
    });

    const result = await agent.prompt({
      role: "user",
      content: "x".repeat(NATIVE_COMPACTION_MIN_INPUT_TOKENS * 4),
      timestamp: Date.now(),
    });

    expect(streamFn.callCount()).toBe(2);
    expect(compactCalls).toBe(1);
    expect(result.at(-1)?.role).toBe("assistant");
    expect(
      streamFn.contexts[1].messages.some(
        (message) =>
          message.role === "user" && typeof message.content === "string" && message.content.includes("forced summary"),
      ),
    ).toBe(true);
  });

  test("does not force compaction more than once for one sampling turn", async () => {
    let compactCalls = 0;
    const nativeCompactFn: NativeCompactFn = async (_input: NativeCompactionInput) => {
      compactCalls++;
      return { status: "ok", summary: "forced summary" };
    };
    const streamFn = createContextOverflowStream(2);
    const agent = new Agent(TEST_MODEL, [{ label: "sys", content: "sys" }], [], {
      effort: "medium",
      llmMsgStreamFn: streamFn,
      llmCompactionFn: nativeCompactFn,
    });

    await expect(
      agent.prompt({
        role: "user",
        content: "x".repeat(NATIVE_COMPACTION_MIN_INPUT_TOKENS * 4),
        timestamp: Date.now(),
      }),
    ).rejects.toThrow("Context overflow");

    expect(streamFn.callCount()).toBe(2);
    expect(compactCalls).toBe(1);
  });
});
