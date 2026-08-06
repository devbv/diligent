// @summary Tests for ProtocolNotificationAdapter: notification → AgentEvent mapping
import { expect, test } from "bun:test";
import { ProtocolNotificationAdapter } from "../src/notification-adapter";
import type { DiligentServerNotification } from "../src/server-notifications";

function makeAdapter() {
  return new ProtocolNotificationAdapter();
}

test("item lifecycle: agentMessage started → delta → completed", () => {
  const adapter = makeAdapter();

  const started: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "agentMessage",
        itemId: "msg1",
        message: {
          role: "assistant",
          content: [],
          model: "x",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 1,
        },
      },
    },
  };

  const events1 = adapter.toAgentEvents(started);
  expect(events1).toHaveLength(1);
  expect(events1[0].type).toBe("message_start");

  const delta: DiligentServerNotification = {
    method: "item/delta",
    params: {
      threadId: "t1",
      turnId: "turn1",
      itemId: "msg1",
      delta: { type: "messageText", itemId: "msg1", delta: "hello" },
    },
  };

  const events2 = adapter.toAgentEvents(delta);
  expect(events2).toHaveLength(1);
  expect(events2[0].type).toBe("message_delta");
  if (events2[0].type === "message_delta") {
    expect(events2[0].delta.type).toBe("text_delta");
    expect(events2[0].delta.delta).toBe("hello");
  }

  const completed: DiligentServerNotification = {
    method: "item/completed",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "agentMessage",
        itemId: "msg1",
        message: {
          role: "assistant",
          content: [],
          model: "x",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 2,
        },
      },
    },
  };

  const events3 = adapter.toAgentEvents(completed);
  expect(events3).toHaveLength(1);
  expect(events3[0].type).toBe("message_end");
});

test("item lifecycle: toolCall started → delta → completed", () => {
  const adapter = makeAdapter();

  const started: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "tool1",
        toolCallId: "tc1",
        toolName: "bash",
        input: { cmd: "ls" },
        render: { inputSummary: "ls", blocks: [] },
      },
    },
  };

  const events1 = adapter.toAgentEvents(started);
  expect(events1).toHaveLength(1);
  expect(events1[0].type).toBe("tool_start");
  if (events1[0].type === "tool_start") {
    expect(events1[0].toolName).toBe("bash");
    expect(events1[0].toolCallId).toBe("tc1");
    expect(events1[0].render).toEqual({ inputSummary: "ls", blocks: [] });
  }

  const delta: DiligentServerNotification = {
    method: "item/delta",
    params: {
      threadId: "t1",
      turnId: "turn1",
      itemId: "tool1",
      delta: { type: "toolOutput", itemId: "tool1", delta: "file.txt" },
    },
  };

  const events2 = adapter.toAgentEvents(delta);
  expect(events2).toHaveLength(1);
  expect(events2[0].type).toBe("tool_update");
  if (events2[0].type === "tool_update") {
    expect(events2[0].partialResult).toBe("file.txt");
  }

  const completed: DiligentServerNotification = {
    method: "item/completed",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "tool1",
        toolCallId: "tc1",
        toolName: "bash",
        input: { cmd: "ls" },
        output: "file.txt\ndir/",
        isError: false,
        metadata: {
          status: {
            kind: "invalid_scope",
            code: "filesystem_root",
            path: "/",
            retryable: false,
            actionable: true,
          },
        },
      },
    },
  };

  const events3 = adapter.toAgentEvents(completed);
  expect(events3).toHaveLength(1);
  expect(events3[0].type).toBe("tool_end");
  if (events3[0].type === "tool_end") {
    expect(events3[0].output).toBe("file.txt\ndir/");
    expect(events3[0].isError).toBe(false);
    expect(events3[0].metadata).toMatchObject({
      status: { kind: "invalid_scope", code: "filesystem_root", path: "/" },
    });
  }
});

test("toolCall completed merges started inputSummary with completed outputSummary", () => {
  const adapter = makeAdapter();

  const started: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "tool1",
        toolCallId: "tc1",
        toolName: "bash",
        input: { cmd: "ls" },
        render: { inputSummary: "ls", blocks: [] },
      },
    },
  };

  const completed: DiligentServerNotification = {
    method: "item/completed",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "tool1",
        toolCallId: "tc1",
        toolName: "bash",
        output: "done",
        isError: true,
        render: { outputSummary: "Command failed", blocks: [] },
      },
    },
  };

  adapter.toAgentEvents(started);
  const events = adapter.toAgentEvents(completed);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("tool_end");
  if (events[0].type === "tool_end") {
    expect(events[0].render).toEqual({
      inputSummary: "ls",
      outputSummary: "Command failed",
      blocks: [],
    });
  }
});

test("delta without started returns empty for toolOutput", () => {
  const adapter = makeAdapter();

  const delta: DiligentServerNotification = {
    method: "item/delta",
    params: {
      threadId: "t1",
      turnId: "turn1",
      itemId: "unknown",
      delta: { type: "toolOutput", itemId: "unknown", delta: "data" },
    },
  };

  expect(adapter.toAgentEvents(delta)).toHaveLength(0);
});

test("delta without started returns fallback message for messageText", () => {
  const adapter = makeAdapter();

  const delta: DiligentServerNotification = {
    method: "item/delta",
    params: {
      threadId: "t1",
      turnId: "turn1",
      itemId: "unknown",
      delta: { type: "messageText", itemId: "unknown", delta: "hello" },
    },
  };

  const events = adapter.toAgentEvents(delta);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("message_delta");
  if (events[0].type === "message_delta") {
    expect(events[0].message.model).toEqual({ provider: "anthropic", modelId: "unknown" });
  }
});

test("status change", () => {
  const adapter = makeAdapter();
  const notification: DiligentServerNotification = {
    method: "thread/status/changed",
    params: { threadId: "t1", status: "busy" },
  };

  const events = adapter.toAgentEvents(notification);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("status_change");
  if (events[0].type === "status_change") {
    expect(events[0].status).toBe("busy");
  }
});

test("usage updated", () => {
  const adapter = makeAdapter();
  const notification: DiligentServerNotification = {
    method: "usage/updated",
    params: {
      threadId: "t1",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
      cost: 0.01,
    },
  };

  const events = adapter.toAgentEvents(notification);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("usage");
  if (events[0].type === "usage") {
    expect(events[0].usage.inputTokens).toBe(100);
    expect(events[0].cost).toBe(0.01);
  }
});

test("error notification", () => {
  const adapter = makeAdapter();
  const notification: DiligentServerNotification = {
    method: "error",
    params: {
      threadId: "t1",
      error: { message: "something broke", name: "Error" },
      fatal: true,
    },
  };

  const events = adapter.toAgentEvents(notification);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("error");
  if (events[0].type === "error") {
    expect(events[0].error.message).toBe("something broke");
    expect(events[0].fatal).toBe(true);
  }
});

test("knowledge saved", () => {
  const adapter = makeAdapter();
  const notification: DiligentServerNotification = {
    method: "knowledge/saved",
    params: { threadId: "t1", knowledgeId: "k1", content: "learned something" },
  };

  const events = adapter.toAgentEvents(notification);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("knowledge_saved");
  if (events[0].type === "knowledge_saved") {
    expect(events[0].knowledgeId).toBe("k1");
  }
});

test("steering injected", () => {
  const adapter = makeAdapter();
  const notification: DiligentServerNotification = {
    method: "steering/injected",
    params: {
      threadId: "t1",
      messageCount: 2,
      steerIds: ["steer-1", "steer-2"],
      messages: [
        { role: "user", content: "change approach", timestamp: 1 },
        { role: "user", content: "use simpler plan", timestamp: 2 },
      ],
    },
  };

  const events = adapter.toAgentEvents(notification);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("steering_injected");
  if (events[0].type === "steering_injected") {
    expect(events[0].messageCount).toBe(2);
    expect(events[0].messages).toEqual(notification.params.messages);
    expect(events[0].steerIds).toEqual(notification.params.steerIds);
  }
});

test("thread compacted maps to compaction_end", () => {
  const adapter = makeAdapter();
  const notification: DiligentServerNotification = {
    method: "thread/compacted",
    params: {
      threadId: "t1",
      entryCount: 3,
      tokensBefore: 15000,
      tokensAfter: 9000,
      summary: "3 entries",
    },
  };

  const events = adapter.toAgentEvents(notification);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("compaction_end");
  if (events[0].type === "compaction_end") {
    expect(events[0].tokensBefore).toBe(15000);
    expect(events[0].tokensAfter).toBe(9000);
    expect(events[0].summary).toBe("3 entries");
  }
});

test("unhandled notifications return empty array", () => {
  const adapter = makeAdapter();
  const notification: DiligentServerNotification = {
    method: "thread/started",
    params: { threadId: "t1" },
  };

  expect(adapter.toAgentEvents(notification)).toHaveLength(0);
});

test("reset clears internal state", () => {
  const adapter = makeAdapter();

  // Start a message to populate internal state
  adapter.toAgentEvents({
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "agentMessage",
        itemId: "msg1",
        message: {
          role: "assistant",
          content: [],
          model: "x",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 1,
        },
      },
    },
  } satisfies DiligentServerNotification);

  adapter.reset();

  // After reset, completing msg1 should use the completed message (not the started one)
  const events = adapter.toAgentEvents({
    method: "item/completed",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "agentMessage",
        itemId: "msg1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final" }],
          model: "y",
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 2,
        },
      },
    },
  } satisfies DiligentServerNotification);

  expect(events).toHaveLength(1);
  if (events[0].type === "message_end") {
    // After reset, the stored message is gone, so it uses the completed item's message
    expect(events[0].message.model).toBe("y");
  }
});

test("thinking delta produces thinking_delta event", () => {
  const adapter = makeAdapter();

  adapter.toAgentEvents({
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "agentMessage",
        itemId: "msg1",
        message: {
          role: "assistant",
          content: [],
          model: "x",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 1,
        },
      },
    },
  } satisfies DiligentServerNotification);

  const events = adapter.toAgentEvents({
    method: "item/delta",
    params: {
      threadId: "t1",
      turnId: "turn1",
      itemId: "msg1",
      delta: { type: "messageThinking", itemId: "msg1", delta: "hmm" },
    },
  } satisfies DiligentServerNotification);

  expect(events).toHaveLength(1);
  if (events[0].type === "message_delta") {
    expect(events[0].delta.type).toBe("thinking_delta");
    expect(events[0].delta.delta).toBe("hmm");
  }
});
