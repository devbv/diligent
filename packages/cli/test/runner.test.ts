import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentEvent, AgentLoopConfig, Message, Model } from "@diligent/core";
import { EventStream } from "@diligent/core";
import type { AppConfig } from "../src/config";
import { NonInteractiveRunner } from "../src/tui/runner";

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
    streamFunction: (() => {
      throw new Error("should not be called");
    }) as unknown as AppConfig["streamFunction"],
    diligent: {},
    sources: [],
    agentLoopFn,
  };
}

const emptyMsg = {
  role: "assistant" as const,
  content: [],
  model: "test-model",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  stopReason: "end_turn" as const,
  timestamp: Date.now(),
};

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

function createFailingAgentLoop(error: Error) {
  const fn = mock((_messages: Message[], _config: AgentLoopConfig) => {
    const stream = new EventStream<AgentEvent, Message[]>(
      (event) => event.type === "agent_end",
      (event) => (event as { type: "agent_end"; messages: Message[] }).messages,
    );

    queueMicrotask(() => {
      stream.error(error);
    });

    return stream;
  });
  return fn;
}

// Capture stdout/stderr writes
function captureOutput(): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdout = process.stdout.write;
  const origStderr = process.stderr.write;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;

  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

afterEach(() => {
  process.stdin.removeAllListeners("data");
  process.stdout.removeAllListeners("resize");
});

describe("NonInteractiveRunner", () => {
  test("basic prompt → stdout text output, exit 0", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "message_start", itemId: "msg-1", message: emptyMsg },
      { type: "message_delta", itemId: "msg-1", message: emptyMsg, delta: { type: "text_delta", delta: "Hello " } },
      { type: "message_delta", itemId: "msg-1", message: emptyMsg, delta: { type: "text_delta", delta: "world!" } },
      { type: "message_end", itemId: "msg-1", message: emptyMsg },
    ];

    const agentLoopFn = createMockAgentLoop(events, []);
    const { stdout, stderr, restore } = captureOutput();

    try {
      const runner = new NonInteractiveRunner(makeConfig(agentLoopFn));
      const exitCode = await runner.run("say hello");
      expect(exitCode).toBe(0);
    } finally {
      restore();
    }

    const allStdout = stdout.join("");
    expect(allStdout).toContain("Hello ");
    expect(allStdout).toContain("world!");
    // Should end with a newline
    expect(allStdout.endsWith("\n")).toBe(true);
  });

  test("tool events → stderr only", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "tool_start", itemId: "tool-1", toolCallId: "tc_1", toolName: "bash", input: { command: "echo hi" } },
      { type: "tool_end", itemId: "tool-1", toolCallId: "tc_1", toolName: "bash", output: "hi\n", isError: false },
      { type: "message_start", itemId: "msg-1", message: emptyMsg },
      { type: "message_delta", itemId: "msg-1", message: emptyMsg, delta: { type: "text_delta", delta: "Done" } },
      { type: "message_end", itemId: "msg-1", message: emptyMsg },
    ];

    const agentLoopFn = createMockAgentLoop(events, []);
    const { stdout, stderr, restore } = captureOutput();

    try {
      const runner = new NonInteractiveRunner(makeConfig(agentLoopFn));
      await runner.run("run echo");
    } finally {
      restore();
    }

    const allStdout = stdout.join("");
    const allStderr = stderr.join("");

    // Tool events go to stderr
    expect(allStderr).toContain("[tool:bash] Running...");
    expect(allStderr).toContain("[tool:bash] Done (2 lines)");

    // Text goes to stdout
    expect(allStdout).toContain("Done");

    // Tool events NOT on stdout
    expect(allStdout).not.toContain("[tool:");
  });

  test("fatal error event → exit 1", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "error", error: { message: "rate limit exceeded", name: "ProviderError" }, fatal: true },
    ];

    const agentLoopFn = createMockAgentLoop(events, []);
    const { stderr, restore } = captureOutput();

    try {
      const runner = new NonInteractiveRunner(makeConfig(agentLoopFn));
      const exitCode = await runner.run("fail");
      expect(exitCode).toBe(1);
    } finally {
      restore();
    }

    const allStderr = stderr.join("");
    expect(allStderr).toContain("[error] rate limit exceeded");
  });

  test("exception in agent loop → exit 1", async () => {
    const agentLoopFn = createFailingAgentLoop(new Error("connection refused"));
    const { stderr, restore } = captureOutput();

    try {
      const runner = new NonInteractiveRunner(makeConfig(agentLoopFn));
      const exitCode = await runner.run("crash");
      expect(exitCode).toBe(1);
    } finally {
      restore();
    }

    const allStderr = stderr.join("");
    expect(allStderr).toContain("[error] connection refused");
  });

  test("non-fatal error → exit 0", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "error", error: { message: "transient hiccup", name: "Error" }, fatal: false },
      { type: "message_start", itemId: "msg-1", message: emptyMsg },
      { type: "message_delta", itemId: "msg-1", message: emptyMsg, delta: { type: "text_delta", delta: "recovered" } },
      { type: "message_end", itemId: "msg-1", message: emptyMsg },
    ];

    const agentLoopFn = createMockAgentLoop(events, []);
    const { stdout, stderr, restore } = captureOutput();

    try {
      const runner = new NonInteractiveRunner(makeConfig(agentLoopFn));
      const exitCode = await runner.run("retry-me");
      expect(exitCode).toBe(0);
    } finally {
      restore();
    }

    expect(stderr.join("")).toContain("[error] transient hiccup");
    expect(stdout.join("")).toContain("recovered");
  });

  test("usage event → stderr with cost", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      {
        type: "usage",
        usage: { inputTokens: 1234, outputTokens: 567, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: 0.0042,
      },
    ];

    const agentLoopFn = createMockAgentLoop(events, []);
    const { stdout, stderr, restore } = captureOutput();

    try {
      const runner = new NonInteractiveRunner(makeConfig(agentLoopFn));
      await runner.run("usage test");
    } finally {
      restore();
    }

    const allStderr = stderr.join("");
    expect(allStderr).toContain("[usage] 1234in/567out ($0.0042)");
    expect(stdout.join("")).toBe("");
  });

  test("compaction events → stderr", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "compaction_start", estimatedTokens: 50_000 },
      { type: "compaction_end", tokensBefore: 50_000, tokensAfter: 12_000, summary: "summarized" },
    ];

    const agentLoopFn = createMockAgentLoop(events, []);
    const { stdout, stderr, restore } = captureOutput();

    try {
      const runner = new NonInteractiveRunner(makeConfig(agentLoopFn));
      await runner.run("compact");
    } finally {
      restore();
    }

    const allStderr = stderr.join("");
    expect(allStderr).toContain("[compaction] Compacting (50k tokens)...");
    expect(allStderr).toContain("[compaction] 50k -> 12k tokens");
    expect(stdout.join("")).toBe("");
  });

  test("knowledge event → stderr", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "knowledge_saved", knowledgeId: "k-1", content: "project uses bun" },
    ];

    const agentLoopFn = createMockAgentLoop(events, []);
    const { stdout, stderr, restore } = captureOutput();

    try {
      const runner = new NonInteractiveRunner(makeConfig(agentLoopFn));
      await runner.run("learn");
    } finally {
      restore();
    }

    expect(stderr.join("")).toContain("[knowledge] project uses bun");
    expect(stdout.join("")).toBe("");
  });

  test("passes correct prompt and config to agentLoopFn", async () => {
    const agentLoopFn = createMockAgentLoop([{ type: "agent_start" }], []);
    const { restore } = captureOutput();

    try {
      const runner = new NonInteractiveRunner(makeConfig(agentLoopFn));
      await runner.run("hello agent");
    } finally {
      restore();
    }

    expect(agentLoopFn).toHaveBeenCalledTimes(1);
    const [messages, config] = agentLoopFn.mock.calls[0];
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    if (messages[0].role === "user") {
      expect(messages[0].content).toBe("hello agent");
    }
    expect(config.model).toEqual(TEST_MODEL);
    expect(config.systemPrompt).toBe("test prompt");
    expect(config.tools.length).toBeGreaterThan(0);
  });

  test("thinking_delta → not written to stdout", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "message_start", itemId: "msg-1", message: emptyMsg },
      {
        type: "message_delta",
        itemId: "msg-1",
        message: emptyMsg,
        delta: { type: "thinking_delta", delta: "internal thought" },
      },
      { type: "message_delta", itemId: "msg-1", message: emptyMsg, delta: { type: "text_delta", delta: "visible" } },
      { type: "message_end", itemId: "msg-1", message: emptyMsg },
    ];

    const agentLoopFn = createMockAgentLoop(events, []);
    const { stdout, restore } = captureOutput();

    try {
      const runner = new NonInteractiveRunner(makeConfig(agentLoopFn));
      await runner.run("think");
    } finally {
      restore();
    }

    const allStdout = stdout.join("");
    expect(allStdout).toContain("visible");
    expect(allStdout).not.toContain("internal thought");
  });

  test("no text output → no trailing newline", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "tool_start", itemId: "tool-1", toolCallId: "tc_1", toolName: "bash", input: { command: "ls" } },
      {
        type: "tool_end",
        itemId: "tool-1",
        toolCallId: "tc_1",
        toolName: "bash",
        output: "file.txt\n",
        isError: false,
      },
    ];

    const agentLoopFn = createMockAgentLoop(events, []);
    const { stdout, restore } = captureOutput();

    try {
      const runner = new NonInteractiveRunner(makeConfig(agentLoopFn));
      const exitCode = await runner.run("list files");
      expect(exitCode).toBe(0);
    } finally {
      restore();
    }

    const allStdout = stdout.join("");
    // No text output means no trailing newline on stdout
    expect(allStdout).toBe("");
  });
});
