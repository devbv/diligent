import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentEvent, AgentLoopConfig, Message, Model } from "@diligent/core";
import { EventStream } from "@diligent/core";
import type { AppConfig } from "../src/config";
import { App } from "../src/tui/app";

const TEST_MODEL: Model = {
  id: "test-model",
  provider: "test",
  contextWindow: 100_000,
  maxOutputTokens: 4096,
};

function makeConfig(agentLoopFn: AppConfig["agentLoopFn"]): AppConfig {
  return {
    apiKey: "test-key",
    model: TEST_MODEL,
    systemPrompt: "test prompt",
    diligent: {},
    sources: [],
    agentLoopFn,
  };
}

function createMockAgentLoop(events: AgentEvent[], resultMessages: Message[]) {
  const fn = mock((_messages: Message[], _config: AgentLoopConfig) => {
    const stream = new EventStream<AgentEvent, Message[]>(
      (event) => event.type === "agent_end",
      (event) => (event as { type: "agent_end"; messages: Message[] }).messages,
    );

    queueMicrotask(() => {
      for (const event of events) {
        stream.push(event);
      }
      stream.push({ type: "agent_end", messages: resultMessages });
      stream.end(resultMessages);
    });

    return stream;
  });
  return fn;
}

function emitChar(ch: string) {
  process.stdin.emit("data", Buffer.from(ch, "utf-8"));
}

function emitText(text: string) {
  for (const ch of text) {
    emitChar(ch);
  }
}

function emitEnter() {
  process.stdin.emit("data", Buffer.from("\r"));
}

function emitCtrlC() {
  process.stdin.emit("data", Buffer.from("\x03"));
}

// Capture stdout.write calls; returns cleanup function
function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const origWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  return {
    writes,
    restore: () => {
      process.stdout.write = origWrite;
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Clean up stdin listeners after each test to avoid cross-test pollution
afterEach(() => {
  process.stdin.removeAllListeners("data");
  process.stdout.removeAllListeners("resize");
});

describe("App", () => {
  test("input → message creation → agent loop invocation", async () => {
    const agentLoopFn = createMockAgentLoop([{ type: "agent_start" }], []);

    const app = new App(makeConfig(agentLoopFn));
    app.start();
    await wait(50);

    emitText("hello");
    emitEnter();
    await wait(200);

    expect(agentLoopFn).toHaveBeenCalledTimes(1);
    const [messages, config] = agentLoopFn.mock.calls[0];
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    if (messages[0].role === "user") {
      expect(messages[0].content).toBe("hello");
    }
    expect(config.model).toEqual(TEST_MODEL);
    expect(config.systemPrompt).toBe("test prompt");
  });

  test("message_delta events → terminal output", async () => {
    const emptyMsg = {
      role: "assistant" as const,
      content: [],
      model: "test-model",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "end_turn" as const,
      timestamp: Date.now(),
    };

    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "message_start", itemId: "msg-1", message: emptyMsg },
      { type: "message_delta", itemId: "msg-1", message: emptyMsg, delta: { type: "text_delta", delta: "Hello " } },
      { type: "message_delta", itemId: "msg-1", message: emptyMsg, delta: { type: "text_delta", delta: "world!" } },
    ];

    const agentLoopFn = createMockAgentLoop(events, []);
    const { writes, restore } = captureStdout();

    try {
      const app = new App(makeConfig(agentLoopFn));
      app.start();
      await wait(50);

      emitText("test");
      emitEnter();
      await wait(200);
    } finally {
      restore();
    }

    const allOutput = writes.join("");
    expect(allOutput).toContain("Hello ");
    expect(allOutput).toContain("world!");
  });

  test("tool_start/tool_end events → spinner and tool output", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "tool_start", itemId: "tool-1", toolCallId: "tc_1", toolName: "bash", input: { command: "echo hi" } },
      { type: "tool_end", itemId: "tool-1", toolCallId: "tc_1", toolName: "bash", output: "hi\n", isError: false },
    ];

    const agentLoopFn = createMockAgentLoop(events, []);
    const { writes, restore } = captureStdout();

    try {
      const app = new App(makeConfig(agentLoopFn));
      app.start();
      await wait(50);

      emitText("run it");
      emitEnter();
      await wait(200);
    } finally {
      restore();
    }

    const allOutput = writes.join("");
    expect(allOutput).toContain("bash"); // spinner shows tool name
    expect(allOutput).toContain("• bash");
  });

  test("error event → error displayed", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "error", error: { message: "something went wrong", name: "Error" }, fatal: false },
    ];

    const agentLoopFn = createMockAgentLoop(events, []);
    const { writes, restore } = captureStdout();

    try {
      const app = new App(makeConfig(agentLoopFn));
      app.start();
      await wait(50);

      emitText("fail");
      emitEnter();
      await wait(200);
    } finally {
      restore();
    }

    const allOutput = writes.join("");
    expect(allOutput).toContain("something went wrong");
  });

  test("Ctrl+C during processing → confirm dialog → abort called", async () => {
    let abortSignal: AbortSignal | undefined;
    const agentLoopFn = mock((_messages: Message[], config: AgentLoopConfig) => {
      abortSignal = config.signal;
      const stream = new EventStream<AgentEvent, Message[]>(
        (event) => event.type === "agent_end",
        (event) => (event as { type: "agent_end"; messages: Message[] }).messages,
      );

      // Slow — don't emit events right away
      setTimeout(() => {
        stream.push({ type: "agent_start" });
        stream.push({ type: "agent_end", messages: [] });
        stream.end([]);
      }, 500);

      return stream;
    });

    const app = new App(makeConfig(agentLoopFn));
    app.start();
    await wait(50);

    emitText("slow");
    emitEnter();
    await wait(100);

    // Send Ctrl+C while processing → shows confirm dialog
    emitCtrlC();
    await wait(50);

    // Confirm abort by pressing 'y'
    emitChar("y");
    await wait(100);

    expect(abortSignal?.aborted).toBe(true);
  });
});
