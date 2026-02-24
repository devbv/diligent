import { describe, test, expect } from "bun:test";
import {
  agentLoop,
  createAnthropicStream,
  bashTool,
} from "@diligent/core";
import type { AgentEvent, AgentLoopConfig, Message, Model } from "@diligent/core";

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
    streamFunction: createAnthropicStream,
    apiKey: apiKey!,
    signal: ac.signal,
    ...overrides,
  };
}

describe("E2E: Real Anthropic API", () => {
  if (!apiKey) {
    test.skip("ANTHROPIC_API_KEY not set — skipping E2E tests", () => {});
    return;
  }

  test(
    "simple conversation without tools",
    async () => {
      const messages: Message[] = [
        {
          role: "user",
          content: "Say exactly: hello world",
          timestamp: Date.now(),
        },
      ];

      const stream = agentLoop(messages, makeConfig({
        tools: [],
        maxTurns: 1,
      }));

      const result = await stream.result();
      const assistant = result.find((m) => m.role === "assistant");
      expect(assistant).toBeDefined();
    },
    30_000,
  );

  test(
    "conversation with bash tool",
    async () => {
      const messages: Message[] = [
        {
          role: "user",
          content:
            "Run 'echo hello' using the bash tool and tell me what it outputs",
          timestamp: Date.now(),
        },
      ];

      const stream = agentLoop(messages, makeConfig({
        systemPrompt: "You are a helpful assistant. Use the bash tool when asked to run commands.",
      }));

      const events: AgentEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      const toolEnd = events.find((e) => e.type === "tool_end");
      expect(toolEnd).toBeDefined();
      if (toolEnd && toolEnd.type === "tool_end") {
        expect(toolEnd.toolName).toBe("bash");
      }
    },
    60_000,
  );
});
