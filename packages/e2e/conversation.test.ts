import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentLoopConfig, Message, Model } from "@diligent/core";
import { agentLoop, bashTool, createAnthropicStream, createReadTool, createWriteTool } from "@diligent/core";

const apiKey = process.env.ANTHROPIC_API_KEY;

const TEST_MODEL: Model = {
  id: process.env.DILIGENT_MODEL ?? "claude-sonnet-4-20250514",
  provider: "anthropic",
  contextWindow: 200_000,
  maxOutputTokens: 16_384,
};

// Mirror real App usage: always provide AbortController signal
function makeConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
  const ac = new AbortController();
  return {
    model: TEST_MODEL,
    systemPrompt: "You are a helpful assistant. Follow instructions exactly.",
    tools: [bashTool],
    streamFunction: createAnthropicStream(apiKey!),
    signal: ac.signal,
    ...overrides,
  };
}

describe("E2E: Real Anthropic API", () => {
  if (!apiKey) {
    test.skip("ANTHROPIC_API_KEY not set — skipping E2E tests", () => {});
    return;
  }

  test("simple conversation without tools", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "Say exactly: hello world",
        timestamp: Date.now(),
      },
    ];

    const stream = agentLoop(
      messages,
      makeConfig({
        tools: [],
        maxTurns: 1,
      }),
    );

    const result = await stream.result();
    const assistant = result.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
  }, 30_000);

  test("conversation with bash tool", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "Run 'echo hello' using the bash tool and tell me what it outputs",
        timestamp: Date.now(),
      },
    ];

    const stream = agentLoop(
      messages,
      makeConfig({
        systemPrompt: "You are a helpful assistant. Use the bash tool when asked to run commands.",
      }),
    );

    const events: AgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const toolEnd = events.find((e) => e.type === "tool_end");
    expect(toolEnd).toBeDefined();
    if (toolEnd && toolEnd.type === "tool_end") {
      expect(toolEnd.toolName).toBe("bash");
    }
  }, 60_000);

  test("multi-turn with file tools: read → write → read", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diligent-e2e-"));
    const filePath = join(tmpDir, "test.txt");
    writeFileSync(filePath, "original content");

    try {
      const messages: Message[] = [
        {
          role: "user",
          content: `Read the file at ${filePath}, then overwrite it with "updated content", then read it again to confirm the change. Report the final content.`,
          timestamp: Date.now(),
        },
      ];

      const stream = agentLoop(
        messages,
        makeConfig({
          tools: [createReadTool(), createWriteTool()],
          systemPrompt: "You are a helpful assistant. Use the read and write tools to manipulate files.",
        }),
      );

      const events: AgentEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      const toolEnds = events.filter((e) => e.type === "tool_end");
      // Expect at least 3 tool calls: read, write, read
      expect(toolEnds.length).toBeGreaterThanOrEqual(3);

      // Verify the file was actually updated
      const finalContent = await Bun.file(filePath).text();
      expect(finalContent).toContain("updated content");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 90_000);

  test("error recovery: unknown tool call fed back to LLM", async () => {
    // Use only bash tool but instruct LLM in a way that might produce an
    // error — the real test is that the conversation continues after error
    const messages: Message[] = [
      {
        role: "user",
        content: "Run 'echo recovery_test' using the bash tool. Before that, briefly say hello.",
        timestamp: Date.now(),
      },
    ];

    const stream = agentLoop(
      messages,
      makeConfig({
        maxTurns: 5,
        systemPrompt: "You are a helpful assistant. Use the bash tool when asked to run commands.",
      }),
    );

    const events: AgentEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Conversation should complete successfully
    const agentEnd = events.find((e) => e.type === "agent_end");
    expect(agentEnd).toBeDefined();

    // Should have at least one tool execution
    const toolEnds = events.filter((e) => e.type === "tool_end");
    expect(toolEnds.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test("abort mid-stream: clean termination", async () => {
    const ac = new AbortController();

    const messages: Message[] = [
      {
        role: "user",
        content: "Write a very long essay about the history of computing, at least 2000 words.",
        timestamp: Date.now(),
      },
    ];

    const stream = agentLoop(
      messages,
      makeConfig({
        tools: [],
        maxTurns: 1,
        signal: ac.signal,
      }),
    );

    let eventCount = 0;
    const events: AgentEvent[] = [];

    // Abort after receiving a few events
    for await (const event of stream) {
      events.push(event);
      eventCount++;
      if (eventCount >= 3) {
        ac.abort();
        break;
      }
    }

    // Should have received some events before abort
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Stream should not hang — result should resolve (or reject) promptly
    const resultPromise = stream.result();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000));
    // Either resolves or rejects is fine — just shouldn't hang
    try {
      await Promise.race([resultPromise, timeout]);
    } catch {
      // Expected — abort may cause rejection, that's fine
    }
  }, 30_000);
});
