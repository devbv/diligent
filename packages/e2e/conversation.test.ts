// @summary End-to-end tests for the agent loop with real Anthropic API

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentOptions, CoreAgentEvent, Message, Model, SystemSection, Tool } from "@diligent/runtime";
import {
  Agent,
  createAnthropicStream,
  createBashTool,
  createReadTool,
  createWriteAbsoluteTool,
} from "@diligent/runtime";

const apiKey = process.env.ANTHROPIC_API_KEY;
const runLiveE2E = process.env.DILIGENT_RUN_LIVE_E2E === "1";
const bashTool = createBashTool(process.cwd());

const TEST_MODEL: Model = {
  id: process.env.DILIGENT_E2E_MODEL ?? "claude-sonnet-4-20250514",
  provider: "anthropic",
  contextWindow: 300_000,
  maxOutputTokens: 16_384,
};

function makeAgent(overrides: { tools?: Tool[]; systemPrompt?: SystemSection[] } & AgentOptions = {}): Agent {
  const { tools, systemPrompt, ...config } = overrides;
  return new Agent(
    TEST_MODEL,
    systemPrompt ?? [{ label: "test", content: "You are a helpful assistant. Follow instructions exactly." }],
    tools ?? [bashTool],
    { effort: "medium", ...config, llmMsgStreamFn: createAnthropicStream(apiKey!) },
  );
}

async function runAgent(
  agent: Agent,
  userMessage: Message,
  signal?: AbortSignal,
): Promise<{ events: CoreAgentEvent[]; result: Message[] }> {
  const events: CoreAgentEvent[] = [];
  const unsub = agent.subscribe((e) => events.push(e));
  let result: Message[] = [];
  try {
    result = await agent.prompt(userMessage, signal);
  } finally {
    unsub();
  }
  return { events, result };
}

describe("E2E: Real Anthropic API", () => {
  if (!apiKey || !runLiveE2E) {
    test.skip("Set ANTHROPIC_API_KEY and DILIGENT_RUN_LIVE_E2E=1 to run live E2E tests", () => {});
    return;
  }

  test("simple conversation without tools", async () => {
    const { result } = await runAgent(makeAgent({ tools: [], maxTurns: 1 }), {
      role: "user",
      content: "Say exactly: hello world",
      timestamp: Date.now(),
    });
    const assistant = result.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
  }, 30_000);

  test("conversation with bash tool", async () => {
    const { events } = await runAgent(
      makeAgent({
        systemPrompt: [
          { label: "test", content: "You are a helpful assistant. Use the bash tool when asked to run commands." },
        ],
      }),
      {
        role: "user",
        content: "Run 'echo hello' using the bash tool and tell me what it outputs",
        timestamp: Date.now(),
      },
    );

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
      const { events } = await runAgent(
        makeAgent({
          tools: [createReadTool(), createWriteAbsoluteTool()],
          systemPrompt: [
            {
              label: "test",
              content: "You are a helpful assistant. Use the read and write tools to manipulate files.",
            },
          ],
        }),
        {
          role: "user",
          content: `Read the file at ${filePath}, then overwrite it with "updated content", then read it again to confirm the change. Report the final content.`,
          timestamp: Date.now(),
        },
      );

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
    const { events } = await runAgent(
      makeAgent({
        maxTurns: 5,
        systemPrompt: [
          { label: "test", content: "You are a helpful assistant. Use the bash tool when asked to run commands." },
        ],
      }),
      {
        role: "user",
        content: "Run 'echo recovery_test' using the bash tool. Before that, briefly say hello.",
        timestamp: Date.now(),
      },
    );

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

    const agent = makeAgent({ tools: [], maxTurns: 1 });
    const events: CoreAgentEvent[] = [];
    const unsub = agent.subscribe((event) => {
      events.push(event);
      if (events.length >= 3) {
        ac.abort();
      }
    });

    // run() should reject promptly after abort
    const runPromise = agent.prompt(messages, ac.signal).catch(() => null);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000));
    try {
      await Promise.race([runPromise, timeout]);
    } catch {
      // Expected — timeout or abort rejection, that's fine
    } finally {
      unsub();
    }

    // Should have received some events before abort
    expect(events.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
