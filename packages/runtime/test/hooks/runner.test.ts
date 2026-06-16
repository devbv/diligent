// @summary Tests for the lifecycle hook runner: exit codes, JSON parsing, blocking, context injection

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput, PluginHookFn } from "../../src/hooks/runner";
import { getLastAssistantMessage, getTurnUsage, runHooks, runPluginHooks } from "../../src/hooks/runner";

const FIXTURE_CWD = tmpdir();

const BASE_INPUT: HookInput = {
  session_id: "test-session",
  transcript_path: "/tmp/test.jsonl",
  cwd: FIXTURE_CWD,
  hook_event_name: "UserPromptSubmit",
  prompt: "hello world",
};

function handler(command: string, timeout?: number, mode?: "sync" | "async") {
  return { type: "command" as const, command, timeout, mode };
}

describe("runHooks", () => {
  describe("exit code behavior", () => {
    test("exit 0 with no output → allowed, no context", async () => {
      const result = await runHooks([handler("exit 0")], BASE_INPUT, FIXTURE_CWD);
      expect(result.blocked).toBe(false);
      expect(result.additionalContext).toBeUndefined();
    });

    test("exit 2 → blocked, stderr as reason", async () => {
      const result = await runHooks([handler('echo "prompt rejected" >&2; exit 2')], BASE_INPUT, FIXTURE_CWD);
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("prompt rejected");
    });

    test("exit 2 with no stderr → generic reason", async () => {
      const result = await runHooks([handler("exit 2")], BASE_INPUT, FIXTURE_CWD);
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("Hook blocked the operation");
    });

    test("exit 1 (non-zero, non-2) → non-blocking error, allowed", async () => {
      const result = await runHooks([handler('echo "some output"; exit 1')], BASE_INPUT, FIXTURE_CWD);
      expect(result.blocked).toBe(false);
    });
  });

  describe("JSON output parsing", () => {
    test("decision block with reason → blocked", async () => {
      const result = await runHooks(
        [handler('echo \'{"decision":"block","reason":"Not allowed"}\'')],
        BASE_INPUT,
        FIXTURE_CWD,
      );
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("Not allowed");
    });

    test("no decision field → allowed", async () => {
      const result = await runHooks([handler('echo \'{"something":"else"}\'')], BASE_INPUT, FIXTURE_CWD);
      expect(result.blocked).toBe(false);
    });

    test("additionalContext in JSON → returned", async () => {
      const result = await runHooks(
        [handler('echo \'{"additionalContext":"Extra info here"}\'')],
        BASE_INPUT,
        FIXTURE_CWD,
      );
      expect(result.blocked).toBe(false);
      expect(result.additionalContext).toBe("Extra info here");
    });

    test("additionalContext in hookSpecificOutput → returned", async () => {
      const result = await runHooks(
        [
          handler(
            'echo \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Nested context"}}\'',
          ),
        ],
        BASE_INPUT,
        FIXTURE_CWD,
      );
      expect(result.blocked).toBe(false);
      expect(result.additionalContext).toBe("Nested context");
    });
  });

  describe("plain text output", () => {
    test("non-JSON stdout → treated as additionalContext", async () => {
      const result = await runHooks([handler('echo "plain context text"')], BASE_INPUT, FIXTURE_CWD);
      expect(result.blocked).toBe(false);
      expect(result.additionalContext).toBe("plain context text");
    });
  });

  describe("multiple handlers", () => {
    test("stops on first blocked handler", async () => {
      const result = await runHooks(
        [handler('echo \'{"decision":"block","reason":"First blocked"}\''), handler('echo "should not run"')],
        BASE_INPUT,
        FIXTURE_CWD,
      );
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("First blocked");
    });

    test("combines additionalContext from multiple allowed handlers", async () => {
      const result = await runHooks(
        [handler('echo "context A"'), handler('echo "context B"')],
        BASE_INPUT,
        FIXTURE_CWD,
      );
      expect(result.blocked).toBe(false);
      expect(result.additionalContext).toContain("context A");
      expect(result.additionalContext).toContain("context B");
    });

    test("empty handlers → allowed", async () => {
      const result = await runHooks([], BASE_INPUT, FIXTURE_CWD);
      expect(result.blocked).toBe(false);
    });
  });

  describe("sync and async modes", () => {
    test("sync hooks wait and can return additionalContext", async () => {
      const result = await runHooks([handler('echo "sync context"', undefined, "sync")], BASE_INPUT, FIXTURE_CWD);
      expect(result.blocked).toBe(false);
      expect(result.additionalContext).toBe("sync context");
    });

    test("async hooks do not wait for output or block the turn", async () => {
      const result = await runHooks(
        [handler('sleep 0.2; echo \'{"decision":"block","reason":"too late"}\'', undefined, "async")],
        BASE_INPUT,
        FIXTURE_CWD,
      );
      expect(result.blocked).toBe(false);
      expect(result.additionalContext).toBeUndefined();
    });

    test("sync hook timeout is configurable", async () => {
      const startedAt = Date.now();
      const result = await runHooks([handler("sleep 2", 0.1, "sync")], BASE_INPUT, FIXTURE_CWD);
      expect(result.blocked).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(1500);
    });
  });

  describe("hook input", () => {
    test("hook receives JSON on stdin with correct fields", async () => {
      const scriptPath = join(FIXTURE_CWD, "check-input.js");
      await Bun.write(
        scriptPath,
        `let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(data);
    if (input.session_id === "test-session" && input.hook_event_name === "UserPromptSubmit" && input.prompt === "hello world") {
      process.exit(0);
    }
    process.stderr.write("unexpected input: " + data);
    process.exit(2);
  } catch (e) {
    process.stderr.write("parse error: " + e.message);
    process.exit(2);
  }
});`,
      );

      const result = await runHooks([handler(`node "${scriptPath}"`)], BASE_INPUT, FIXTURE_CWD);
      expect(result.blocked).toBe(false);
    });
  });
});

describe("runPluginHooks", () => {
  test("async plugin hooks do not block on returned results", async () => {
    let completed = false;
    const asyncHook: PluginHookFn = async () => {
      await Bun.sleep(100);
      completed = true;
      return { blocked: true, reason: "too late" };
    };
    asyncHook.mode = "async";

    const startedAt = Date.now();
    const result = await runPluginHooks([asyncHook], BASE_INPUT);

    expect(result.blocked).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(80);

    await Bun.sleep(150);
    expect(completed).toBe(true);
  });
});

describe("getLastAssistantMessage", () => {
  test("returns empty string for empty array", () => {
    expect(getLastAssistantMessage([])).toBe("");
  });

  test("returns empty string when no assistant messages", () => {
    const messages = [{ role: "user" as const, content: "hello", timestamp: 1 }];
    expect(getLastAssistantMessage(messages)).toBe("");
  });

  test("returns text content of last assistant message (string)", () => {
    const messages = [
      { role: "user" as const, content: "hello", timestamp: 1 },
      { role: "assistant" as const, content: "Hi there!", timestamp: 2 },
    ];
    expect(getLastAssistantMessage(messages)).toBe("Hi there!");
  });

  test("returns concatenated text blocks for array content", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "Part 1. " },
          { type: "text" as const, text: "Part 2." },
        ],
        timestamp: 1,
      },
    ];
    expect(getLastAssistantMessage(messages)).toBe("Part 1. Part 2.");
  });

  test("returns last assistant message, not first", () => {
    const messages = [
      { role: "assistant" as const, content: "First response", timestamp: 1 },
      { role: "user" as const, content: "follow-up", timestamp: 2 },
      { role: "assistant" as const, content: "Second response", timestamp: 3 },
    ];
    expect(getLastAssistantMessage(messages)).toBe("Second response");
  });
});

describe("getTurnUsage", () => {
  test("returns zero when no assistant message exists in current turn", () => {
    const usage = getTurnUsage([
      { role: "user", content: "hello", timestamp: 1 },
      { role: "tool_result", toolCallId: "tc1", toolName: "read", output: "ok", isError: false, timestamp: 2 },
    ]);
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  test("counts only assistant usage after the latest user message", () => {
    const usage = getTurnUsage([
      {
        role: "assistant",
        content: [{ type: "text", text: "prev turn" }],
        model: "fake-model",
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1 },
        stopReason: "end_turn",
        timestamp: 1,
      },
      { role: "user", content: "current turn", timestamp: 2 },
      {
        role: "assistant",
        content: [{ type: "text", text: "tool_use" }],
        model: "fake-model",
        usage: { inputTokens: 30, outputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 0 },
        stopReason: "tool_use",
        timestamp: 3,
      },
      {
        role: "tool_result",
        toolCallId: "tc2",
        toolName: "grep",
        output: "result",
        isError: false,
        timestamp: 4,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
        model: "fake-model",
        usage: { inputTokens: 40, outputTokens: 15, cacheReadTokens: 3, cacheWriteTokens: 1 },
        stopReason: "end_turn",
        timestamp: 5,
      },
    ]);

    expect(usage).toEqual({
      inputTokens: 70,
      outputTokens: 25,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
    });
  });
});
