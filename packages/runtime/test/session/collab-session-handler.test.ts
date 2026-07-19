// @summary Restored collaboration policy extraction from persisted parent tool evidence

import { describe, expect, test } from "bun:test";
import type { Message } from "@diligent/core/message-contract";
import { CollabSessionHandler } from "../../src/session/collab-session-handler";
import type { SessionEntry } from "../../src/session/types";

describe("CollabSessionHandler", () => {
  test("links a successful spawn result to its immutable persisted spawn policy", () => {
    const entries = [
      messageEntry("call", assistantCall()),
      messageEntry("result", {
        role: "tool_result",
        toolCallId: "spawn-1",
        toolName: "spawn_agent",
        output: JSON.stringify({ thread_id: "child-1", nickname: "Scout" }),
        isError: false,
        timestamp: 2,
      }),
    ];

    expect(new CollabSessionHandler(() => entries).getHistoricalCollabAgents()).toEqual([
      {
        threadId: "child-1",
        nickname: "Scout",
        policy: {
          agentType: "explore",
          modelClass: "lite",
          allowedTools: ["read"],
          allowNestedAgents: false,
        },
      },
    ]);
  });

  test("does not attach policy from a different, failed, or malformed spawn call", () => {
    const entries = [
      messageEntry("call", assistantCall()),
      messageEntry("other", {
        role: "tool_result",
        toolCallId: "other",
        toolName: "spawn_agent",
        output: JSON.stringify({ thread_id: "child-1", nickname: "Scout" }),
        isError: false,
        timestamp: 2,
      }),
      messageEntry("failed", {
        role: "tool_result",
        toolCallId: "spawn-1",
        toolName: "spawn_agent",
        output: JSON.stringify({ thread_id: "child-1", nickname: "Scout" }),
        isError: true,
        timestamp: 3,
      }),
    ];

    expect(new CollabSessionHandler(() => entries).getHistoricalCollabAgents()).toEqual([
      { threadId: "child-1", nickname: "Scout" },
    ]);
  });
});

function assistantCall(): Message {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_call",
        id: "spawn-1",
        name: "spawn_agent",
        input: {
          message: "read the source",
          agent_type: "explore",
          model_class: "lite",
          allowed_tools: ["read"],
          allow_nested_agents: false,
        },
      },
    ],
    model: { provider: "anthropic", modelId: "test-model" },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "tool_use",
    timestamp: 1,
  };
}

function messageEntry(id: string, message: Message): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message };
}
