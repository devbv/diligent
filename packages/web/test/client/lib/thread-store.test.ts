// @summary Tests for thread-state reducer behavior over item lifecycle notifications
import { expect, test } from "bun:test";
import { DILIGENT_SERVER_NOTIFICATION_METHODS, type DiligentServerNotification } from "@diligent/protocol";
import { ProtocolNotificationAdapter } from "@diligent/runtime/client";
import {
  hydrateFromThreadRead,
  initialThreadState,
  reduceServerNotification,
} from "../../../src/client/lib/thread-store";
import { USER_FACING_NETWORK_ERROR_MESSAGE } from "../../../src/client/lib/user-facing-errors";
import { WEB_IMAGE_ROUTE_PREFIX } from "../../../src/shared/image-routes";

function reduce(state: typeof initialThreadState, notification: DiligentServerNotification) {
  const adapter = adapterInstance;
  const events = adapter.toAgentEvents(notification);
  return reduceServerNotification(state, notification, events);
}

function hasErrorRenderItem(items: Array<{ kind: string }>): boolean {
  return items.some((item) => item.kind === "error");
}

// Shared adapter instance for tests that need stateful item tracking
let adapterInstance: ProtocolNotificationAdapter;

function resetAdapter() {
  adapterInstance = new ProtocolNotificationAdapter();
}

// Reset before each test sequence
resetAdapter();

test("thread identity notifications do not switch visible history without hydrate", () => {
  resetAdapter();

  const seeded = {
    ...initialThreadState,
    activeThreadId: "thread-old",
    activeThreadCwd: "/old",
    items: [
      {
        id: "old-user",
        kind: "user" as const,
        text: "old visible history",
        images: [],
        timestamp: 1,
      },
    ],
  };

  const next = reduce(seeded, {
    method: "thread/resumed",
    params: { threadId: "thread-new" },
  });

  expect(next.activeThreadId).toBe("thread-old");
  expect(next.items).toBe(seeded.items);
});

test("merges item started/delta/completed into single assistant item", () => {
  resetAdapter();
  const started: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "agentMessage",
        itemId: "item1",
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

  const delta: DiligentServerNotification = {
    method: "item/delta",
    params: {
      threadId: "t1",
      turnId: "turn1",
      itemId: "item1",
      delta: {
        type: "messageText",
        itemId: "item1",
        delta: "hello",
      },
    },
  };

  const completed: DiligentServerNotification = {
    method: "item/completed",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "agentMessage",
        itemId: "item1",
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

  const a = reduce(initialThreadState, started);
  const b = reduce(a, delta);
  const c = reduce(b, completed);

  const assistant = c.items.find((item) => item.kind === "assistant");
  expect(assistant).toBeDefined();
  expect(assistant && assistant.kind === "assistant" ? assistant.text : "").toBe("hello");
});

test("assistant message appends provider-native web blocks during message_delta", () => {
  const startedEvent = {
    type: "message_start",
    itemId: "item1",
    message: {
      role: "assistant",
      content: [],
      model: "x",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "end_turn",
      timestamp: 1,
    },
  } as const;
  const deltaEvent = {
    type: "message_delta",
    itemId: "item1",
    message: startedEvent.message,
    delta: {
      type: "content_block_delta",
      block: {
        type: "provider_tool_use",
        id: "ws_1",
        provider: "openai",
        name: "web_search",
        input: { type: "search", query: "diligent" },
      },
    },
  } as const;

  const started: DiligentServerNotification = {
    method: "agent/event",
    params: { threadId: "t1", turnId: "turn1", threadStatus: "busy", event: startedEvent },
  };
  const delta: DiligentServerNotification = {
    method: "agent/event",
    params: { threadId: "t1", turnId: "turn1", threadStatus: "busy", event: deltaEvent },
  };

  const next = reduceServerNotification(initialThreadState, started, [startedEvent]);
  const finalState = reduceServerNotification(next, delta, [deltaEvent]);
  const assistant = finalState.items.find((item) => item.kind === "assistant");
  expect(assistant).toBeDefined();
  expect(assistant && assistant.kind === "assistant" ? assistant.contentBlocks : []).toEqual([
    {
      type: "provider_tool_use",
      id: "ws_1",
      provider: "openai",
      name: "web_search",
      input: { type: "search", query: "diligent" },
    },
  ]);
});

test("ignores duplicate started item events", () => {
  resetAdapter();
  const started: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "tool1",
        toolCallId: "tool1",
        toolName: "bash",
        input: { cmd: "ls" },
      },
    },
  };

  const a = reduce(initialThreadState, started);
  const b = reduce(a, started);

  expect(a.items.length).toBe(1);
  expect(b.items.length).toBe(1);
});

test("computes tool duration when tool completes", () => {
  resetAdapter();
  const started: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "tool1",
        toolCallId: "tool1",
        toolName: "bash",
        input: { cmd: "ls" },
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
        toolCallId: "tool1",
        toolName: "bash",
        input: { cmd: "ls" },
        output: "done",
        isError: false,
      },
    },
  };

  const realNow = Date.now;
  let now = 400;
  Date.now = () => now;
  try {
    const startedState = reduce(initialThreadState, started);
    now = 700;
    const completedState = reduce(startedState, completed);
    const tool = completedState.items.find((item) => item.kind === "tool");

    expect(tool && tool.kind === "tool" ? tool.durationMs : undefined).toBe(300);
    expect(tool && tool.kind === "tool" ? tool.status : "").toBe("done");
  } finally {
    Date.now = realNow;
  }
});

test("compaction notifications render the actual summary in context items", () => {
  resetAdapter();

  const summary = "Another language model started...\n\nActual compacted summary";
  const compacted: DiligentServerNotification = {
    method: "thread/compacted",
    params: {
      threadId: "t1",
      entryCount: 3,
      tokensBefore: 4000,
      tokensAfter: 1800,
      summary,
    },
  };

  const next = reduce(initialThreadState, compacted);
  const context = next.items.find((item) => item.kind === "context");
  expect(context).toBeDefined();
  expect(context && context.kind === "context" ? context.summary : "").toBe(summary);
  expect(next.isCompacting).toBe(false);
});

test("thread compaction started toggles compacting state immediately", () => {
  resetAdapter();

  const started: DiligentServerNotification = {
    method: DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_COMPACTION_STARTED,
    params: {
      threadId: "t1",
      estimatedTokens: 1234,
    },
  };

  const next = reduce(initialThreadState, started);
  expect(next.isCompacting).toBe(true);
});

test("thread compacted notification adds context item without waiting for rehydrate", () => {
  resetAdapter();

  const next = reduce(initialThreadState, {
    method: "thread/compacted",
    params: {
      threadId: "t1",
      entryCount: 1,
      tokensBefore: 4000,
      tokensAfter: 2000,
      summary: "Compacted",
    },
  });

  expect(next.items.some((item) => item.kind === "context" && item.summary === "Compacted")).toBe(true);
  expect(next.isCompacting).toBe(false);
});

test("error during compaction clears compacting and busy state immediately", () => {
  resetAdapter();

  const next = reduce(
    {
      ...initialThreadState,
      activeThreadId: "t1",
      threadStatus: "busy",
      isCompacting: true,
      activeTurnId: "turn-1",
      activeTurnStartedAt: 1000,
      activeReasoningStartedAt: 1100,
      activeReasoningDurationMs: 50,
    },
    {
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR,
      params: {
        threadId: "t1",
        error: { message: "Estimated Token is below 50000", name: "Error" },
        fatal: false,
      },
    },
  );

  expect(next.threadStatus).toBe("idle");
  expect(next.isCompacting).toBe(false);
  expect(next.activeTurnId).toBeNull();
  expect(next.activeTurnStartedAt).toBeNull();
  expect(next.activeReasoningStartedAt).toBeNull();
  expect(next.activeReasoningDurationMs).toBe(0);
  expect(next.activeError?.message).toBe("Estimated Token is below 50000");
  expect(next.toast).toBeNull();
});

test("error event sets activeError without appending a RenderItem", () => {
  resetAdapter();

  const next = reduce(
    { ...initialThreadState, activeThreadId: "t1", activeTurnId: "turn-1", threadStatus: "busy" },
    {
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR,
      params: {
        threadId: "t1",
        error: {
          message: "ChatGPT API error (401): unauthorized",
          name: "ProviderError",
          providerErrorType: "auth",
        },
        fatal: false,
      },
    },
  );

  expect(hasErrorRenderItem(next.items)).toBe(false);
  expect(next.activeError?.providerErrorType).toBe("auth");
  expect(next.activeError?.message).toBe("ChatGPT API error (401): unauthorized");
  expect(next.activeError?.fatal).toBe(false);
  expect(next.activeError?.turnId).toBe("turn-1");
  expect(next.toast).toBeNull();
});

test("network error event shows a user-facing message instead of raw transport details", () => {
  resetAdapter();

  const next = reduce(
    { ...initialThreadState, activeThreadId: "t1", threadStatus: "busy" },
    {
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR,
      params: {
        threadId: "t1",
        error: {
          message: "The socket connection was closed unexpectedly. For more information, pass verbose: true.",
          name: "ProviderError",
          providerErrorType: "network",
          isRetryable: true,
        },
        fatal: false,
      },
    },
  );

  expect(hasErrorRenderItem(next.items)).toBe(false);
  expect(next.activeError?.providerErrorType).toBe("network");
  expect(next.activeError?.message).toBe(USER_FACING_NETWORK_ERROR_MESSAGE);
  expect(next.toast).toBeNull();
});

test("hydrateFromThreadRead keeps history error entries out of visible items", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    threadId: "t1",
    items: [],
    errors: [
      {
        id: "err-1",
        error: {
          message: "ChatGPT API error (401): unauthorized",
          name: "ProviderError",
          providerErrorType: "auth",
        },
        fatal: false,
        turnId: "turn-1",
        timestamp: "2024-05-13T01:00:00.000Z",
      },
    ],
  });

  expect(hasErrorRenderItem(hydrated.items)).toBe(false);
  expect(hydrated.activeError).toBeNull();
});

test("failed turn completion keeps activeError until a later successful turn completes", () => {
  resetAdapter();

  const startedFailed = reduce(
    { ...initialThreadState, activeThreadId: "t1" },
    {
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_STARTED,
      params: { threadId: "t1", turnId: "turn-1" },
    },
  );
  const failed = reduce(startedFailed, {
    method: DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR,
    params: {
      threadId: "t1",
      error: { message: "invalid Anthropic key", name: "ProviderError", providerErrorType: "auth" },
      fatal: false,
    },
  });
  const afterFailedCompletion = reduce(failed, {
    method: DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED,
    params: { threadId: "t1", turnId: "turn-1" },
  });

  expect(afterFailedCompletion.activeError?.message).toBe("invalid Anthropic key");

  const startedSuccess = reduce(afterFailedCompletion, {
    method: DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_STARTED,
    params: { threadId: "t1", turnId: "turn-2" },
  });
  const afterSuccessCompletion = reduce(startedSuccess, {
    method: DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED,
    params: { threadId: "t1", turnId: "turn-2" },
  });

  expect(afterSuccessCompletion.activeError).toBeNull();
});

test("hydrateFromThreadRead ignores history network errors for visible state", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    threadId: "t1",
    items: [],
    errors: [
      {
        id: "err-1",
        error: {
          message: "The socket connection was closed unexpectedly. For more information, pass verbose: true.",
          name: "ProviderError",
          providerErrorType: "network",
          isRetryable: true,
        },
        fatal: false,
        turnId: "turn-1",
        timestamp: "2024-05-13T01:00:00.000Z",
      },
    ],
  });

  expect(hasErrorRenderItem(hydrated.items)).toBe(false);
  expect(hydrated.activeError).toBeNull();
});

test("plan tool completion sets planState when unresolved steps remain", () => {
  resetAdapter();
  const threadId = "t1";

  const started: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId,
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "plan-tool-1",
        toolCallId: "plan-tool-1",
        toolName: "plan",
        input: {},
      },
    },
  };
  const completed: DiligentServerNotification = {
    method: "item/completed",
    params: {
      threadId,
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "plan-tool-1",
        toolCallId: "plan-tool-1",
        toolName: "plan",
        output: JSON.stringify({
          title: "Plan",
          steps: [
            { text: "step-1", status: "done" },
            { text: "step-2", status: "in_progress" },
          ],
        }),
        isError: false,
      },
    },
  };

  const state = reduce(reduce(initialThreadState, started), completed);
  expect(state.planState).toBeDefined();
  expect(state.planState?.steps[1]?.status).toBe("in_progress");
});

test("plan tool completion clears planState when all steps resolved", () => {
  resetAdapter();
  const threadId = "t1";
  const seeded = {
    ...initialThreadState,
    planState: {
      title: "Old",
      steps: [{ text: "old", status: "in_progress" as const }],
    },
  };

  const started: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId,
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "plan-tool-2",
        toolCallId: "plan-tool-2",
        toolName: "plan",
        input: {},
      },
    },
  };
  const completed: DiligentServerNotification = {
    method: "item/completed",
    params: {
      threadId,
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "plan-tool-2",
        toolCallId: "plan-tool-2",
        toolName: "plan",
        output: JSON.stringify({
          title: "Plan",
          steps: [
            { text: "step-1", status: "done" },
            { text: "step-2", status: "cancelled" },
          ],
        }),
        isError: false,
      },
    },
  };

  const state = reduce(reduce(seeded, started), completed);
  expect(state.planState).toBeNull();
});

test("tool_end updates hydrated in-progress tool by toolCallId fallback", () => {
  resetAdapter();
  const threadId = "t1";
  const seeded = {
    ...initialThreadState,
    itemSlots: {},
    items: [
      {
        id: "hydrated-tool-1",
        kind: "tool" as const,
        toolName: "bash",
        inputText: '{\n  "command": "pwd"\n}',
        outputText: "",
        isError: false,
        status: "streaming" as const,
        timestamp: 100,
        toolCallId: "tool-call-1",
        startedAt: 100,
      },
    ],
  };

  const completed: DiligentServerNotification = {
    method: "item/completed",
    params: {
      threadId,
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "new-item-id-after-reconnect",
        toolCallId: "tool-call-1",
        toolName: "bash",
        output: "/repo\n",
        isError: false,
      },
    },
  };

  const state = reduce(seeded, completed);
  const tool = state.items.find((item) => item.kind === "tool" && item.toolCallId === "tool-call-1");
  expect(tool).toBeDefined();
  expect(tool && tool.kind === "tool" ? tool.status : "").toBe("done");
  expect(tool && tool.kind === "tool" ? tool.outputText : "").toBe("/repo\n");
});

test("collab-rendered tools are not duplicated as generic tool items", () => {
  resetAdapter();
  const threadId = "t1";

  const started: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId,
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "collab-tool-1",
        toolCallId: "collab-tool-1",
        toolName: "spawn_agent",
        input: { description: "do work" },
      },
    },
  };

  const state = reduce(initialThreadState, started);
  expect(state.items.filter((item) => item.kind === "tool")).toHaveLength(0);
});

test("uses completed tool render payload so live read blocks match hydrated blocks", () => {
  resetAdapter();
  const started: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "tool-read-1",
        toolCallId: "tool-read-1",
        toolName: "read",
        input: { file_path: "/repo/src/app.ts", offset: 5, limit: 10 },
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
        itemId: "tool-read-1",
        toolCallId: "tool-read-1",
        toolName: "read",
        input: { file_path: "/repo/src/app.ts", offset: 5, limit: 10 },
        output: "5\tline one\n6\tline two",
        isError: false,
        render: {
          inputSummary: "src/app.ts",
          outputSummary: "5\tline one",
          blocks: [
            {
              type: "file",
              filePath: "/repo/src/app.ts",
              content: "5\tline one\n6\tline two",
              offset: 5,
              limit: 10,
            },
          ],
        },
      },
    },
  };

  const startedState = reduce(initialThreadState, started);
  const completedState = reduce(startedState, completed);
  const tool = completedState.items.find((item) => item.kind === "tool");

  expect(tool).toBeDefined();
  expect(tool && tool.kind === "tool" ? tool.render : undefined).toEqual(completed.params.item.render);
});

test("merges started request summary with completed response summary", () => {
  resetAdapter();
  const started: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "tool-err-1",
        toolCallId: "tool-err-1",
        toolName: "bash",
        input: { command: "exit 1" },
        render: { inputSummary: "exit 1", blocks: [] },
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
        itemId: "tool-err-1",
        toolCallId: "tool-err-1",
        toolName: "bash",
        output: "[Exit code: 1]",
        isError: true,
        render: { outputSummary: "Command failed (exit 1)", blocks: [] },
      },
    },
  };

  const startedState = reduce(initialThreadState, started);
  const completedState = reduce(startedState, completed);
  const tool = completedState.items.find((item) => item.kind === "tool");

  expect(tool).toBeDefined();
  expect(tool && tool.kind === "tool" ? tool.isError : false).toBe(true);
  expect(tool && tool.kind === "tool" ? tool.render?.inputSummary : undefined).toBe("exit 1");
  expect(tool && tool.kind === "tool" ? tool.render?.outputSummary : undefined).toBe("Command failed (exit 1)");
});

test("creates a new assistant item when same itemId appears in a new turn", () => {
  resetAdapter();
  const startedTurn1: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "agentMessage",
        itemId: "item1",
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

  const deltaTurn1: DiligentServerNotification = {
    method: "item/delta",
    params: {
      threadId: "t1",
      turnId: "turn1",
      itemId: "item1",
      delta: {
        type: "messageText",
        itemId: "item1",
        delta: "first",
      },
    },
  };

  const completedTurn1: DiligentServerNotification = {
    method: "item/completed",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "agentMessage",
        itemId: "item1",
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

  const startedTurn2: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn2",
      item: {
        type: "agentMessage",
        itemId: "item1",
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

  const deltaTurn2: DiligentServerNotification = {
    method: "item/delta",
    params: {
      threadId: "t1",
      turnId: "turn2",
      itemId: "item1",
      delta: {
        type: "messageText",
        itemId: "item1",
        delta: "second",
      },
    },
  };

  const s1 = reduce(initialThreadState, startedTurn1);
  const s2 = reduce(s1, deltaTurn1);
  const s3 = reduce(s2, completedTurn1);
  const s4 = reduce(s3, startedTurn2);
  const s5 = reduce(s4, deltaTurn2);

  const assistants = s5.items.filter((item) => item.kind === "assistant");
  expect(assistants.length).toBe(2);
  expect(assistants[0] && assistants[0].kind === "assistant" ? assistants[0].text : "").toBe("first");
  expect(assistants[1] && assistants[1].kind === "assistant" ? assistants[1].text : "").toBe("second");
});

test("steering_injected clears pending steers by count even when event text differs", () => {
  resetAdapter();
  const startState = {
    ...initialThreadState,
    pendingSteers: ["change approach", "focus root cause"],
  };

  const notification: DiligentServerNotification = {
    method: "steering/injected",
    params: {
      threadId: "t1",
      messageCount: 1,
      messages: [{ role: "user", content: "change approach (normalized)", timestamp: 1 }],
    },
  };

  const next = reduce(startState, notification);
  expect(next.pendingSteers).toEqual(["focus root cause"]);

  const injectedUsers = next.items.filter((item) => item.kind === "user");
  expect(injectedUsers).toHaveLength(1);
  expect(injectedUsers[0] && injectedUsers[0].kind === "user" ? injectedUsers[0].text : "").toBe("change approach");
});

test("steering_injected keeps local queued text but preserves event images", () => {
  resetAdapter();
  const startState = {
    ...initialThreadState,
    pendingSteers: ["change approach"],
  };

  const notification: DiligentServerNotification = {
    method: DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT,
    params: {
      threadId: "t1",
      turnId: "turn1",
      threadStatus: "busy",
      event: {
        type: "steering_injected",
        messageCount: 1,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "change approach (normalized)" },
              {
                type: "local_image",
                path: "/repo/.diligent/images/thread-1/shot.png",
                mediaType: "image/png",
                fileName: "shot.png",
              },
            ],
            timestamp: 1,
          },
        ],
      },
    },
  };

  const next = reduceServerNotification(startState, notification, [notification.params.event]);
  const injectedUsers = next.items.filter((item) => item.kind === "user");
  expect(injectedUsers).toHaveLength(1);
  expect(injectedUsers[0] && injectedUsers[0].kind === "user" ? injectedUsers[0].text : "").toBe("change approach");
  expect(injectedUsers[0] && injectedUsers[0].kind === "user" ? injectedUsers[0].images : []).toEqual([
    {
      url: `${WEB_IMAGE_ROUTE_PREFIX}thread-1/shot.png`,
      fileName: "shot.png",
      mediaType: "image/png",
    },
  ]);
});

test("steering_injected falls back to event text when local queue is empty", () => {
  resetAdapter();
  const notification: DiligentServerNotification = {
    method: "steering/injected",
    params: {
      threadId: "t1",
      messageCount: 1,
      messages: [{ role: "user", content: "server-injected steer", timestamp: 2 }],
    },
  };

  const next = reduce(initialThreadState, notification);
  expect(next.pendingSteers).toEqual([]);

  const injectedUsers = next.items.filter((item) => item.kind === "user");
  expect(injectedUsers).toHaveLength(1);
  expect(injectedUsers[0] && injectedUsers[0].kind === "user" ? injectedUsers[0].text : "").toBe(
    "server-injected steer",
  );
});

test("steering_injected falls back to event images when local queue is empty", () => {
  const next = reduceServerNotification(
    initialThreadState,
    {
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT,
      params: {
        threadId: "t1",
        turnId: "turn1",
        threadStatus: "busy",
        event: {
          type: "steering_injected",
          messageCount: 1,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "server-injected steer" },
                {
                  type: "local_image",
                  path: "/repo/.diligent/images/thread-1/shot.png",
                  mediaType: "image/png",
                  fileName: "shot.png",
                },
              ],
              timestamp: 2,
            },
          ],
        },
      },
    } as DiligentServerNotification,
    [
      {
        type: "steering_injected",
        messageCount: 1,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "server-injected steer" },
              {
                type: "local_image",
                path: "/repo/.diligent/images/thread-1/shot.png",
                mediaType: "image/png",
                fileName: "shot.png",
              },
            ],
            timestamp: 2,
          },
        ],
      },
    ],
  );

  const injectedUsers = next.items.filter((item) => item.kind === "user");
  expect(injectedUsers).toHaveLength(1);
  expect(injectedUsers[0] && injectedUsers[0].kind === "user" ? injectedUsers[0].images : []).toEqual([
    {
      url: `${WEB_IMAGE_ROUTE_PREFIX}thread-1/shot.png`,
      fileName: "shot.png",
      mediaType: "image/png",
    },
  ]);
});

test("hydrateFromThreadRead restores user images from local_image blocks", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    items: [
      {
        type: "userMessage",
        itemId: "u1",
        message: {
          role: "user",
          content: [
            { type: "text", text: "What is in this screenshot?" },
            {
              type: "local_image",
              path: "/repo/.diligent/images/thread-1/shot.png",
              mediaType: "image/png",
              fileName: "shot.png",
            },
          ],
          timestamp: 100,
        },
      },
    ],
    hasFollowUp: false,
    entryCount: 1,
    isRunning: false,
    currentEffort: "medium",
  });

  const user = hydrated.items.find((item) => item.kind === "user");
  expect(user && user.kind === "user" ? user.text : "").toBe("What is in this screenshot?");
  expect(user && user.kind === "user" ? user.images : []).toEqual([
    { url: `${WEB_IMAGE_ROUTE_PREFIX}thread-1/shot.png`, fileName: "shot.png", mediaType: "image/png" },
  ]);
});

test("hydrateFromThreadRead converts persisted local images to browser-safe route URLs", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    items: [
      {
        type: "userMessage",
        itemId: "u1",
        message: {
          role: "user",
          content: [
            {
              type: "local_image",
              path: "/repo/.diligent/images/thread-1/shot 1.png",
              mediaType: "image/png",
              fileName: "shot 1.png",
            },
          ],
          timestamp: 101,
        },
      },
    ],
    hasFollowUp: false,
    entryCount: 1,
    isRunning: false,
    currentEffort: "medium",
  });

  const user = hydrated.items.find((item) => item.kind === "user");
  expect(user && user.kind === "user" ? user.images : []).toEqual([
    {
      url: `${WEB_IMAGE_ROUTE_PREFIX}thread-1/shot%201.png`,
      fileName: "shot 1.png",
      mediaType: "image/png",
    },
  ]);
});

test("hydrateFromThreadRead restores tool_call input and merges matching tool_result output", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    items: [
      {
        type: "toolCall",
        itemId: "tool:tc-read-1",
        toolCallId: "tc-read-1",
        toolName: "read",
        input: { file_path: "/repo/src/app.ts" },
        timestamp: 100,
        startedAt: 100,
      },
      {
        type: "toolCall",
        itemId: "tool:tc-read-1",
        toolCallId: "tc-read-1",
        toolName: "read",
        input: { file_path: "/repo/src/app.ts" },
        output: "1| const x = 1;",
        isError: false,
        timestamp: 101,
        startedAt: 100,
        durationMs: 1,
      },
    ],
    hasFollowUp: false,
    entryCount: 2,
    currentEffort: "medium",
  });

  const tool = hydrated.items.find((item) => item.kind === "tool" && item.toolCallId === "tc-read-1");
  expect(tool && tool.kind === "tool" ? tool.toolName : "").toBe("read");
  expect(tool && tool.kind === "tool" ? tool.inputText : "").toContain("file_path");
  expect(tool && tool.kind === "tool" ? tool.outputText : "").toContain("const x = 1");
});

test("hydrateFromThreadRead reuses snapshot tool renders for bash start and completion", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    cwd: "/repo",
    items: [
      {
        type: "toolCall",
        itemId: "tool:tc-bash-1",
        toolCallId: "tc-bash-1",
        toolName: "bash",
        input: { command: "pwd" },
        timestamp: 1_000,
        startedAt: 1_000,
        render: {
          inputSummary: "pwd",
          blocks: [],
        },
      },
      {
        type: "toolCall",
        itemId: "tool:tc-bash-1",
        toolCallId: "tc-bash-1",
        toolName: "bash",
        input: { command: "pwd" },
        output: "/repo",
        isError: false,
        timestamp: 2_350,
        startedAt: 1_000,
        durationMs: 1_350,
        render: {
          inputSummary: "pwd",
          outputSummary: "Command completed",
          blocks: [{ type: "command", command: "pwd", output: "/repo", isError: false }],
        },
      },
    ],
    hasFollowUp: false,
    entryCount: 2,
    isRunning: false,
    currentEffort: "medium",
  });

  const tool = hydrated.items.find((item) => item.kind === "tool" && item.toolCallId === "tc-bash-1");
  expect(tool).toBeDefined();
  if (!tool || tool.kind !== "tool") throw new Error("Expected hydrated tool item");

  expect(tool.inputText).toContain('"command": "pwd"');
  expect(tool.outputText).toBe("/repo");
  expect(tool.status).toBe("done");
  expect(tool.startedAt).toBe(1_000);
  expect(tool.durationMs).toBe(1_350);
  expect(tool.render).toEqual({
    inputSummary: "pwd",
    outputSummary: "Command completed",
    blocks: [{ type: "command", command: "pwd", output: "/repo", isError: false }],
  });
});

test("hydrateFromThreadRead keeps assistant text when snapshot has message_end only (no deltas)", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    cwd: "/repo",
    items: [
      {
        type: "agentMessage",
        itemId: "a-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "assistant from snapshot" }],
          model: "x",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 123,
        },
      },
    ],
    hasFollowUp: false,
    entryCount: 1,
    isRunning: false,
    currentEffort: "medium",
  });

  const assistant = hydrated.items.find((item) => item.kind === "assistant");
  expect(assistant).toBeDefined();
  expect(assistant && assistant.kind === "assistant" ? assistant.text : "").toBe("assistant from snapshot");
  expect(assistant && assistant.kind === "assistant" ? assistant.thinkingDone : false).toBe(true);
  expect(assistant && assistant.kind === "assistant" ? assistant.contentBlocks : []).toEqual([
    { type: "text", text: "assistant from snapshot" },
  ]);
});

test("hydrateFromThreadRead preserves provider-native web blocks and citations on assistant items", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    cwd: "/repo",
    items: [
      {
        type: "agentMessage",
        itemId: "a-web-1",
        message: {
          role: "assistant",
          content: [
            {
              type: "provider_tool_use",
              id: "ws_1",
              provider: "openai",
              name: "web_search",
              input: { query: "diligent" },
            },
            {
              type: "web_search_result",
              toolUseId: "ws_1",
              provider: "openai",
              results: [{ url: "https://example.com", title: "Example", snippet: "Result snippet" }],
            },
            {
              type: "text",
              text: "Found it.",
              citations: [
                {
                  type: "web_search_result_location",
                  url: "https://example.com",
                  title: "Example",
                  citedText: "Found",
                },
              ],
            },
          ],
          model: "gpt-5",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 123,
        },
      },
    ],
    hasFollowUp: false,
    entryCount: 1,
    isRunning: false,
    currentEffort: "medium",
  });

  const assistant = hydrated.items.find((item) => item.kind === "assistant");
  expect(assistant).toBeDefined();
  expect(assistant && assistant.kind === "assistant" ? assistant.contentBlocks : []).toEqual([
    { type: "provider_tool_use", id: "ws_1", provider: "openai", name: "web_search", input: { query: "diligent" } },
    {
      type: "web_search_result",
      toolUseId: "ws_1",
      provider: "openai",
      results: [{ url: "https://example.com", title: "Example", snippet: "Result snippet" }],
    },
    {
      type: "text",
      text: "Found it.",
      citations: [
        { type: "web_search_result_location", url: "https://example.com", title: "Example", citedText: "Found" },
      ],
    },
  ]);
});

test("hydrateFromThreadRead restores post-compaction history from snapshot items", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    items: [
      {
        type: "userMessage",
        itemId: "a1",
        timestamp: 100,
        message: {
          role: "user",
          content: "old user",
          timestamp: 100,
        },
      },
      {
        type: "agentMessage",
        itemId: "a2",
        timestamp: 200,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old assistant" }],
          model: "x",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 200,
        },
      },
      {
        type: "compaction",
        itemId: "c1",
        timestamp: 300,
        summary: "Compacted summary",
        tokensBefore: 0,
        tokensAfter: 0,
      },
      {
        type: "userMessage",
        itemId: "a3",
        timestamp: 500,
        message: {
          role: "user",
          content: "new user",
          timestamp: 500,
        },
      },
    ],
    errors: [],
    hasFollowUp: false,
    entryCount: 4,
    isRunning: false,
    currentEffort: "medium",
    currentModel: "x",
    totalCost: 0,
  });

  const userTexts = hydrated.items
    .filter((item) => item.kind === "user")
    .map((item) => (item.kind === "user" ? item.text : ""));
  const assistantTexts = hydrated.items
    .filter((item) => item.kind === "assistant")
    .map((item) => (item.kind === "assistant" ? item.text : ""));
  const contexts = hydrated.items.filter((item) => item.kind === "context");

  expect(userTexts).toEqual(["old user", "new user"]);
  expect(assistantTexts).toEqual(["old assistant"]);
  expect(contexts).toHaveLength(1);
  expect(contexts[0] && contexts[0].kind === "context" ? contexts[0].summary : "").toBe("Compacted summary");
});

test("hydrateFromThreadRead preserves detailed compaction summary when displaySummary is condensed", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    items: [
      {
        type: "compaction",
        itemId: "c1",
        timestamp: 300,
        summary: "## Goal\nRecover Anthropic compacted details",
        displaySummary: "Compacted",
        tokensBefore: 0,
        tokensAfter: 0,
      },
    ],
    errors: [],
    hasFollowUp: false,
    entryCount: 1,
    isRunning: false,
    currentEffort: "medium",
    currentModel: "x",
    totalCost: 0,
  });

  const contexts = hydrated.items.filter((item) => item.kind === "context");
  expect(contexts).toHaveLength(1);
  expect(contexts[0] && contexts[0].kind === "context" ? contexts[0].summary : "").toContain(
    "Recover Anthropic compacted details",
  );
});

test("hydrateFromThreadRead keeps tool_result even without prior tool_call block", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    items: [
      {
        type: "toolCall",
        itemId: "tool:tc-ls-1",
        toolCallId: "tc-ls-1",
        toolName: "ls",
        input: {},
        output: "src/\nREADME.md",
        isError: false,
        timestamp: 200,
        startedAt: 200,
        durationMs: 0,
      },
    ],
    hasFollowUp: false,
    entryCount: 1,
    currentEffort: "medium",
  });

  const tool = hydrated.items.find((item) => item.kind === "tool" && item.toolCallId === "tc-ls-1");
  expect(tool).toBeDefined();
  expect(tool && tool.kind === "tool" ? tool.toolName : "").toBe("ls");
  expect(tool && tool.kind === "tool" ? tool.outputText : "").toContain("README.md");
});

test("hydrateFromThreadRead shows running sub-agent as running when parent isRunning and not yet waited", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    items: [
      {
        type: "toolCall",
        itemId: "tool:tc-spawn-1",
        toolCallId: "tc-spawn-1",
        toolName: "spawn_agent",
        input: { description: "do work" },
        output: JSON.stringify({ thread_id: "ses-child-1", nickname: "Cleo" }),
        isError: false,
        timestamp: 101,
        startedAt: 100,
        durationMs: 1,
      },
    ],
    isRunning: true,
    hasFollowUp: false,
    entryCount: 2,
    currentEffort: "medium",
  });

  const collab = hydrated.items.find((item) => item.kind === "collab" && item.eventType === "spawn");
  expect(collab).toBeDefined();
  expect(collab && collab.kind === "collab" ? collab.status : "").toBe("running");
});

test("hydrateFromThreadRead shows wait-derived final status on spawn item", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    items: [
      {
        type: "toolCall",
        itemId: "tool:tc-spawn-1",
        toolCallId: "tc-spawn-1",
        toolName: "spawn_agent",
        input: { description: "do work" },
        output: JSON.stringify({ thread_id: "ses-child-1", nickname: "Cleo" }),
        isError: false,
        timestamp: 101,
        startedAt: 100,
        durationMs: 1,
      },
      {
        type: "toolCall",
        itemId: "tool:tc-wait-1",
        toolCallId: "tc-wait-1",
        toolName: "wait",
        input: { ids: ["ses-child-1"] },
        output: JSON.stringify({
          status: { "ses-child-1": { kind: "completed", output: "done" } },
          timed_out: false,
        }),
        isError: false,
        timestamp: 103,
        startedAt: 102,
        durationMs: 1,
      },
    ],
    isRunning: true,
    hasFollowUp: false,
    entryCount: 4,
    currentEffort: "medium",
  });

  const spawn = hydrated.items.find((item) => item.kind === "collab" && item.eventType === "spawn");
  expect(spawn).toBeDefined();
  expect(spawn && spawn.kind === "collab" ? spawn.status : "").toBe("completed");

  expect(spawn && spawn.kind === "collab" ? spawn.childMessages : undefined).toBeUndefined();

  const wait = hydrated.items.find((item) => item.kind === "collab" && item.eventType === "wait");
  expect(wait).toBeDefined();
  expect(wait && wait.kind === "collab" ? wait.agents?.[0]?.nickname : undefined).toBe("Cleo");
});

test("hydrateFromThreadRead shows close-derived final status on spawn item", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    items: [
      {
        type: "toolCall",
        itemId: "tool:tc-spawn-1",
        toolCallId: "tc-spawn-1",
        toolName: "spawn_agent",
        input: { description: "do work" },
        output: JSON.stringify({ thread_id: "ses-child-1", nickname: "Cleo" }),
        isError: false,
        timestamp: 101,
        startedAt: 100,
        durationMs: 1,
      },
      {
        type: "toolCall",
        itemId: "tool:tc-close-1",
        toolCallId: "tc-close-1",
        toolName: "close_agent",
        input: { id: "ses-child-1" },
        output: JSON.stringify({
          thread_id: "ses-child-1",
          nickname: "Cleo",
          final_status: { kind: "shutdown" },
        }),
        isError: false,
        timestamp: 103,
        startedAt: 102,
        durationMs: 1,
      },
    ],
    isRunning: false,
    hasFollowUp: false,
    entryCount: 4,
    currentEffort: "medium",
  });

  const spawn = hydrated.items.find((item) => item.kind === "collab" && item.eventType === "spawn");
  expect(spawn).toBeDefined();
  expect(spawn && spawn.kind === "collab" ? spawn.status : "").toBe("shutdown");
});

test("turn/interrupted settles in-flight thinking and streaming tool items", () => {
  resetAdapter();

  // Simulate: assistant thinking is in-flight (thinkingDone=false, no text yet)
  const itemStarted: DiligentServerNotification = {
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
  const thinkingDelta: DiligentServerNotification = {
    method: "item/delta",
    params: {
      threadId: "t1",
      turnId: "turn1",
      itemId: "msg1",
      delta: { type: "messageThinking", itemId: "msg1", delta: "hmm..." },
    },
  };
  const toolStarted: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "tool1",
        toolCallId: "tc1",
        toolName: "bash",
        input: { cmd: "sleep 10" },
      },
    },
  };

  let state = reduce({ ...initialThreadState, activeThreadId: "t1", threadStatus: "busy" }, itemStarted);
  state = reduce(state, thinkingDelta);
  state = reduce(state, toolStarted);

  // Verify in-flight state before interrupt
  const thinkingBefore = state.items.find((i) => i.kind === "assistant");
  expect(thinkingBefore && thinkingBefore.kind === "assistant" ? thinkingBefore.thinkingDone : true).toBe(false);
  const toolBefore = state.items.find((i) => i.kind === "tool");
  expect(toolBefore && toolBefore.kind === "tool" ? toolBefore.status : "done").toBe("streaming");
  expect(state.threadStatus).toBe("busy");

  // Now send turn/interrupted
  const interrupted: DiligentServerNotification = {
    method: "turn/interrupted",
    params: { threadId: "t1", turnId: "turn1" },
  };
  const after = reduce(state, interrupted);

  // threadStatus should be idle
  expect(after.threadStatus).toBe("idle");
  // assistant thinking should be settled
  const thinkingAfter = after.items.find((i) => i.kind === "assistant");
  expect(thinkingAfter && thinkingAfter.kind === "assistant" ? thinkingAfter.thinkingDone : false).toBe(true);
  // tool should be done
  const toolAfter = after.items.find((i) => i.kind === "tool");
  expect(toolAfter && toolAfter.kind === "tool" ? toolAfter.status : "streaming").toBe("done");
  // itemSlots should be cleared
  expect(Object.keys(after.itemSlots).length).toBe(0);
});

test("turn/completed locally computes final loop and reasoning duration on latest assistant item", () => {
  resetAdapter();

  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;

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

  const completedMessage: DiligentServerNotification = {
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

  const turnCompleted: DiligentServerNotification = {
    method: "turn/completed",
    params: {
      threadId: "t1",
      turnId: "turn1",
    },
  };

  try {
    let state = reduce(
      { ...initialThreadState, activeThreadId: "t1" },
      {
        method: "turn/started",
        params: { threadId: "t1", turnId: "turn1" },
      },
    );
    state = reduce(state, started);
    now = 1_400;
    state = reduce(state, {
      method: "item/delta",
      params: {
        threadId: "t1",
        turnId: "turn1",
        itemId: "msg1",
        delta: { type: "messageThinking", itemId: "msg1", delta: "thinking..." },
      },
    });
    now = 2_000;
    state = reduce(state, {
      method: "item/delta",
      params: {
        threadId: "t1",
        turnId: "turn1",
        itemId: "msg1",
        delta: { type: "messageText", itemId: "msg1", delta: "done" },
      },
    });
    state = reduce(state, completedMessage);
    now = 3_500;
    state = reduce(state, turnCompleted);

    const assistant = state.items.find((item) => item.kind === "assistant");
    expect(assistant && assistant.kind === "assistant" ? assistant.turnDurationMs : undefined).toBe(2500);
    expect(assistant && assistant.kind === "assistant" ? assistant.reasoningDurationMs : undefined).toBe(600);
  } finally {
    Date.now = realNow;
  }
});

test("collab_spawn_begin creates spawn item so child events stream in real-time", () => {
  resetAdapter();
  const threadId = "t1";
  const childThreadId = "child-1";
  const base = { ...initialThreadState, activeThreadId: threadId };

  // 1. collab_spawn_begin → eagerly creates the spawn item
  const spawnBegin: DiligentServerNotification = {
    method: "collab/spawn/begin",
    params: {
      threadId,
      callId: childThreadId,
      prompt: "do something",
    },
  };
  let state = reduce(base, spawnBegin);
  const earlyItem = state.items.find((i) => i.kind === "collab" && i.eventType === "spawn");
  expect(earlyItem).toBeDefined();
  expect(earlyItem && earlyItem.kind === "collab" ? earlyItem.childThreadId : "").toBe(childThreadId);
  expect(earlyItem && earlyItem.kind === "collab" ? earlyItem.status : "").toBe("running");

  // 2. Child tool_start before collab_spawn_end — should nest into the spawn item
  const toolStarted: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId,
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "child-tool-1",
        toolCallId: "tc-bash-1",
        toolName: "bash",
        input: { command: "ls" },
      },
      childThreadId,
      nickname: "Fern",
    },
  };
  state = reduce(state, toolStarted);
  const afterStart = state.items.find((i) => i.kind === "collab" && i.eventType === "spawn");
  expect(afterStart && afterStart.kind === "collab" ? afterStart.childTools.length : 0).toBe(1);

  // 3. Child tool_update — streams before spawn_end arrives
  const toolDelta: DiligentServerNotification = {
    method: "item/delta",
    params: {
      threadId,
      turnId: "turn1",
      itemId: "child-tool-1",
      delta: { type: "toolOutput", itemId: "child-tool-1", delta: "streaming!" },
      childThreadId,
      nickname: "Fern",
    },
  };
  state = reduce(state, toolDelta);
  const afterDelta = state.items.find((i) => i.kind === "collab" && i.eventType === "spawn");
  expect(afterDelta && afterDelta.kind === "collab" ? afterDelta.childTools[0].outputText : "").toBe("streaming!");

  // 4. collab_spawn_end → should update (not duplicate) the existing item
  const spawnEnd: DiligentServerNotification = {
    method: "collab/spawn/end",
    params: {
      threadId,
      callId: childThreadId,
      childThreadId,
      nickname: "Fern",
      description: "worker",
      prompt: "do something",
      status: "running",
    },
  };
  state = reduce(state, spawnEnd);
  const collabItems = state.items.filter((i) => i.kind === "collab" && i.eventType === "spawn");
  expect(collabItems.length).toBe(1); // No duplicate
  expect(collabItems[0] && collabItems[0].kind === "collab" ? collabItems[0].nickname : "").toBe("Fern");
  expect(collabItems[0] && collabItems[0].kind === "collab" ? collabItems[0].description : "").toBe("worker");
  // childTools should be preserved
  expect(collabItems[0] && collabItems[0].kind === "collab" ? collabItems[0].childTools.length : 0).toBe(1);
});

test("child tool_update streams into collab spawn item childTools", () => {
  resetAdapter();
  const threadId = "t1";
  const childThreadId = "child-1";
  const base = { ...initialThreadState, activeThreadId: threadId };

  // 1. collab_spawn_begin → create the spawn item
  const spawnBegin: DiligentServerNotification = {
    method: "collab/spawn/begin",
    params: {
      threadId,
      callId: childThreadId,
      prompt: "do work",
    },
  };
  let state = reduce(base, spawnBegin);
  const spawnItem = state.items.find((i) => i.kind === "collab" && i.eventType === "spawn");
  expect(spawnItem).toBeDefined();

  // 2. item/started (toolCall with childThreadId) → add to childTools
  const toolStarted: DiligentServerNotification = {
    method: "item/started",
    params: {
      threadId,
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "child-tool-1",
        toolCallId: "tc-bash-1",
        toolName: "bash",
        input: { command: "ls" },
      },
      childThreadId,
      nickname: "Fern",
    },
  };
  state = reduce(state, toolStarted);
  const afterStart = state.items.find((i) => i.kind === "collab" && i.eventType === "spawn");
  expect(afterStart && afterStart.kind === "collab" ? afterStart.childTools.length : 0).toBe(1);
  expect(afterStart && afterStart.kind === "collab" ? afterStart.childTools[0].status : "").toBe("running");

  // 3. item/delta (toolOutput with childThreadId) → stream into childTools
  const toolDelta1: DiligentServerNotification = {
    method: "item/delta",
    params: {
      threadId,
      turnId: "turn1",
      itemId: "child-tool-1",
      delta: { type: "toolOutput", itemId: "child-tool-1", delta: "file1.ts\n" },
      childThreadId,
      nickname: "Fern",
    },
  };
  state = reduce(state, toolDelta1);
  const afterDelta1 = state.items.find((i) => i.kind === "collab" && i.eventType === "spawn");
  expect(afterDelta1 && afterDelta1.kind === "collab" ? afterDelta1.childTools[0].outputText : "").toBe("file1.ts\n");

  // 4. Another delta — should append
  const toolDelta2: DiligentServerNotification = {
    method: "item/delta",
    params: {
      threadId,
      turnId: "turn1",
      itemId: "child-tool-1",
      delta: { type: "toolOutput", itemId: "child-tool-1", delta: "file2.ts\n" },
      childThreadId,
      nickname: "Fern",
    },
  };
  state = reduce(state, toolDelta2);
  const afterDelta2 = state.items.find((i) => i.kind === "collab" && i.eventType === "spawn");
  expect(afterDelta2 && afterDelta2.kind === "collab" ? afterDelta2.childTools[0].outputText : "").toBe(
    "file1.ts\nfile2.ts\n",
  );

  // 5. item/completed → finalize the tool
  const toolCompleted: DiligentServerNotification = {
    method: "item/completed",
    params: {
      threadId,
      turnId: "turn1",
      item: {
        type: "toolCall",
        itemId: "child-tool-1",
        toolCallId: "tc-bash-1",
        toolName: "bash",
        input: { command: "ls" },
        output: "file1.ts\nfile2.ts\n",
        isError: false,
      },
      childThreadId,
      nickname: "Fern",
    },
  };
  state = reduce(state, toolCompleted);
  const afterEnd = state.items.find((i) => i.kind === "collab" && i.eventType === "spawn");
  expect(afterEnd && afterEnd.kind === "collab" ? afterEnd.childTools[0].status : "").toBe("done");
  expect(afterEnd && afterEnd.kind === "collab" ? afterEnd.childTools[0].outputText : "").toBe("file1.ts\nfile2.ts\n");
});

test("collab_spawn_end updates same spawn item to errored status", () => {
  resetAdapter();
  const threadId = "t1";
  const childThreadId = "child-err-1";

  let state = reduce(
    { ...initialThreadState, activeThreadId: threadId },
    {
      method: "collab/spawn/begin",
      params: {
        threadId,
        callId: childThreadId,
        prompt: "read 3 markdown files",
      },
    },
  );

  state = reduce(state, {
    method: "collab/spawn/end",
    params: {
      threadId,
      callId: childThreadId,
      childThreadId,
      nickname: "Broom",
      prompt: "read 3 markdown files",
      status: "running",
    },
  });

  state = reduce(state, {
    method: "collab/spawn/end",
    params: {
      threadId,
      callId: childThreadId,
      childThreadId,
      nickname: "Broom",
      prompt: "read 3 markdown files",
      status: "errored",
      message: "400 The requested model 'codex-mini-latest' does not exist.",
    },
  });

  const collabItems = state.items.filter((i) => i.kind === "collab" && i.eventType === "spawn");
  expect(collabItems.length).toBe(1);
  const spawn = collabItems[0];
  expect(spawn && spawn.kind === "collab" ? spawn.status : "").toBe("errored");
  expect(spawn && spawn.kind === "collab" ? spawn.message : "").toContain("does not exist");
});

test("collab spawn item keeps original spawn prompt for detail display", () => {
  resetAdapter();
  const threadId = "t1";
  const childThreadId = "child-prompt-1";
  const prompt = "check auth flow\nthen summarize issues";

  let state = reduce(
    { ...initialThreadState, activeThreadId: threadId },
    {
      method: "collab/spawn/begin",
      params: {
        threadId,
        callId: childThreadId,
        prompt,
      },
    },
  );

  state = reduce(state, {
    method: "collab/spawn/end",
    params: {
      threadId,
      callId: childThreadId,
      childThreadId,
      nickname: "Fern",
      prompt,
      status: "running",
    },
  });

  const spawn = state.items.find((i) => i.kind === "collab" && i.eventType === "spawn");
  expect(spawn && spawn.kind === "collab" ? spawn.prompt : "").toBe(prompt);
});

test("collab_wait_end keeps spawn status running when timed out snapshot reports pending", () => {
  resetAdapter();
  const threadId = "t1";
  const childThreadId = "child-pending-1";

  let state = reduce(
    { ...initialThreadState, activeThreadId: threadId },
    {
      method: "collab/spawn/begin",
      params: {
        threadId,
        callId: childThreadId,
        prompt: "long task",
      },
    },
  );

  state = reduce(state, {
    method: "collab/spawn/end",
    params: {
      threadId,
      callId: childThreadId,
      childThreadId,
      nickname: "Moss",
      prompt: "long task",
      status: "running",
    },
  });

  state = reduce(state, {
    method: "collab/wait/end",
    params: {
      threadId,
      callId: "wait-1",
      agentStatuses: [
        {
          threadId: childThreadId,
          nickname: "Moss",
          status: "pending",
          message: undefined,
        },
      ],
      timedOut: true,
    },
  });

  const spawn = state.items.find((i) => i.kind === "collab" && i.eventType === "spawn");
  expect(spawn && spawn.kind === "collab" ? spawn.status : "").toBe("running");
});

test("hydrateFromThreadRead upgrades timed-out wait snapshot to completed when snapshot agents are final", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    cwd: "/repo",
    items: [
      {
        type: "toolCall",
        itemId: "tool:spawn-1",
        toolCallId: "spawn-1",
        toolName: "spawn_agent",
        input: { message: "task", description: "desc", agent_type: "general" },
        output: JSON.stringify({ thread_id: "child-1", nickname: "Moss" }),
        timestamp: 1000,
        startedAt: 1000,
      },
      {
        type: "toolCall",
        itemId: "tool:wait-1",
        toolCallId: "wait-1",
        toolName: "wait",
        input: { ids: ["child-1"] },
        output: JSON.stringify({
          status: { "child-1": { kind: "running" } },
          timed_out: true,
        }),
        timestamp: 2000,
        startedAt: 2000,
      },
      {
        type: "collabEvent",
        itemId: "collab-wait-1",
        eventKind: "wait",
        agents: [
          {
            threadId: "child-1",
            nickname: "Moss",
            status: "completed",
            message: "done later",
          },
        ],
        timedOut: false,
        timestamp: 2000,
      },
    ],
    errors: [],
    hasFollowUp: false,
    entryCount: 2,
    isRunning: false,
    currentEffort: "medium",
    currentModel: "test-model",
  });

  const spawn = hydrated.items.find((item) => item.kind === "collab" && item.eventType === "spawn");
  expect(spawn && spawn.kind === "collab" ? spawn.status : "").toBe("completed");

  const wait = hydrated.items.find((item) => item.kind === "collab" && item.eventType === "wait");
  expect(wait && wait.kind === "collab" ? wait.status : "").toBe("completed");
  expect(wait && wait.kind === "collab" ? wait.timedOut : true).toBe(false);
});

test("collab_wait_begin shows running wait item before wait_end", () => {
  resetAdapter();
  const threadId = "t1";
  const childThreadId = "child-live-wait-1";

  let state = reduce(
    { ...initialThreadState, activeThreadId: threadId },
    {
      method: "collab/wait/begin",
      params: {
        threadId,
        callId: "wait-1",
        agents: [{ threadId: childThreadId, nickname: "Holly" }],
      },
    },
  );

  const waitItem = state.items.find((item) => item.kind === "collab" && item.eventType === "wait");
  expect(waitItem).toBeDefined();
  expect(waitItem && waitItem.kind === "collab" ? waitItem.status : "").toBe("running");
  expect(waitItem && waitItem.kind === "collab" ? waitItem.agents?.[0]?.nickname : undefined).toBe("Holly");

  state = reduce(state, {
    method: "collab/wait/end",
    params: {
      threadId,
      callId: "wait-1",
      agentStatuses: [{ threadId: childThreadId, nickname: "Holly", status: "completed", message: "done" }],
      timedOut: false,
    },
  });

  const waitItems = state.items.filter((item) => item.kind === "collab" && item.eventType === "wait");
  expect(waitItems).toHaveLength(1);
  const updatedWait = waitItems[0];
  expect(updatedWait && updatedWait.kind === "collab" ? updatedWait.status : "").toBe("completed");
});

test("collab_close_end appends close item and updates spawn status", () => {
  resetAdapter();
  const threadId = "t1";
  const childThreadId = "child-close-1";

  let state = reduce(
    { ...initialThreadState, activeThreadId: threadId },
    {
      method: "collab/spawn/begin",
      params: {
        threadId,
        callId: childThreadId,
        prompt: "close me",
      },
    },
  );

  state = reduce(state, {
    method: "collab/spawn/end",
    params: {
      threadId,
      callId: childThreadId,
      childThreadId,
      nickname: "Pine",
      prompt: "close me",
      status: "running",
    },
  });

  state = reduce(state, {
    method: "collab/close/end",
    params: {
      threadId,
      callId: "close-call-1",
      childThreadId,
      nickname: "Pine",
      status: "shutdown",
      message: "closed",
    },
  });

  const close = state.items.find((item) => item.kind === "collab" && item.eventType === "close");
  expect(close).toBeDefined();
  expect(close && close.kind === "collab" ? close.status : "").toBe("shutdown");

  const spawn = state.items.find((item) => item.kind === "collab" && item.eventType === "spawn");
  expect(spawn).toBeDefined();
  expect(spawn && spawn.kind === "collab" ? spawn.status : "").toBe("shutdown");
  expect(spawn && spawn.kind === "collab" ? spawn.message : "").toBe("closed");
});

test("collab_interaction_end creates interaction item", () => {
  resetAdapter();
  const threadId = "t1";

  const state = reduce(
    { ...initialThreadState, activeThreadId: threadId },
    {
      method: "collab/interaction/end",
      params: {
        threadId,
        callId: "interaction-call-1",
        receiverThreadId: "child-rx-1",
        receiverNickname: "Birch",
        prompt: "Please summarize these files",
        status: "completed",
      },
    },
  );

  const interaction = state.items.find((item) => item.kind === "collab" && item.eventType === "interaction");
  expect(interaction).toBeDefined();
  expect(interaction && interaction.kind === "collab" ? interaction.childThreadId : "").toBe("child-rx-1");
  expect(interaction && interaction.kind === "collab" ? interaction.nickname : "").toBe("Birch");
  expect(interaction && interaction.kind === "collab" ? interaction.status : "").toBe("completed");
});

test("collab_wait_end keeps spawn running when timed out snapshot reports running", () => {
  resetAdapter();
  const threadId = "t1";
  const childThreadId = "child-running-timeout-1";

  let state = reduce(
    { ...initialThreadState, activeThreadId: threadId },
    {
      method: "collab/spawn/begin",
      params: {
        threadId,
        callId: childThreadId,
        prompt: "long task",
      },
    },
  );

  state = reduce(state, {
    method: "collab/spawn/end",
    params: {
      threadId,
      callId: childThreadId,
      childThreadId,
      nickname: "Willow",
      prompt: "long task",
      status: "running",
    },
  });

  state = reduce(state, {
    method: "collab/wait/end",
    params: {
      threadId,
      callId: "wait-timeout-1",
      agentStatuses: [
        {
          threadId: childThreadId,
          nickname: "Willow",
          status: "running",
          message: "still working",
        },
      ],
      timedOut: true,
    },
  });

  const spawn = state.items.find((item) => item.kind === "collab" && item.eventType === "spawn");
  expect(spawn).toBeDefined();
  expect(spawn && spawn.kind === "collab" ? spawn.status : "").toBe("running");
  expect(spawn && spawn.kind === "collab" ? spawn.message : "").toBe("still working");
});

test("child assistant timeline keeps latest final message text on message_end", () => {
  resetAdapter();
  const threadId = "t1";
  const childThreadId = "child-msg-1";

  let state = reduce(
    { ...initialThreadState, activeThreadId: threadId },
    {
      method: "collab/spawn/begin",
      params: {
        threadId,
        callId: childThreadId,
        prompt: "respond",
      },
    },
  );

  state = reduce(state, {
    method: "item/started",
    params: {
      threadId,
      turnId: "turn1",
      item: {
        type: "agentMessage",
        itemId: "child-msg-item-1",
        message: {
          role: "assistant",
          content: [],
          model: "x",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 10,
        },
      },
      childThreadId,
      nickname: "Spruce",
    },
  });

  state = reduce(state, {
    method: "item/delta",
    params: {
      threadId,
      turnId: "turn1",
      itemId: "child-msg-item-1",
      delta: { type: "messageText", itemId: "child-msg-item-1", delta: "partial text" },
      childThreadId,
      nickname: "Spruce",
    },
  });

  state = reduce(state, {
    method: "item/completed",
    params: {
      threadId,
      turnId: "turn1",
      item: {
        type: "agentMessage",
        itemId: "child-msg-item-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final text" }],
          model: "x",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "end_turn",
          timestamp: 11,
        },
      },
      childThreadId,
      nickname: "Spruce",
    },
  });

  const spawn = state.items.find((item) => item.kind === "collab" && item.eventType === "spawn");
  expect(spawn).toBeDefined();
  expect(spawn && spawn.kind === "collab" ? spawn.childTimeline?.length : 0).toBe(1);
  const assistantEntry =
    spawn && spawn.kind === "collab" ? spawn.childTimeline?.find((entry) => entry.kind === "assistant") : undefined;
  const message = assistantEntry && assistantEntry.kind === "assistant" ? assistantEntry.message : "";
  expect(message).not.toBe("partial text");
  expect(message).toContain('"role": "assistant"');
});

test("authoritative thread status from item notifications updates header state", () => {
  resetAdapter();
  const threadId = "t1";

  let state = {
    ...initialThreadState,
    activeThreadId: threadId,
    threadStatus: "idle" as const,
  };

  state = reduce(state, {
    method: "item/started",
    params: {
      threadId,
      turnId: "turn1",
      threadStatus: "busy",
      item: {
        type: "agentMessage",
        itemId: "assistant-1",
        message: {
          role: "assistant",
          content: [],
          model: "x",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "tool_use",
          timestamp: 10,
        },
      },
    },
  });

  expect(state.threadStatus).toBe("busy");
});

test("hydrateFromThreadRead keeps sub-agent running until wait/close settles status", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    items: [
      {
        type: "toolCall",
        itemId: "tool:tc-spawn-1",
        toolCallId: "tc-spawn-1",
        toolName: "spawn_agent",
        input: { description: "do work" },
        output: JSON.stringify({ thread_id: "ses-child-1", nickname: "Cleo" }),
        isError: false,
        timestamp: 101,
        startedAt: 100,
        durationMs: 1,
      },
    ],
    isRunning: false,
    hasFollowUp: false,
    entryCount: 2,
    currentEffort: "medium",
  });

  const collab = hydrated.items.find((item) => item.kind === "collab" && item.eventType === "spawn");
  expect(collab).toBeDefined();
  expect(collab && collab.kind === "collab" ? collab.status : "").toBe("running");
});

test("hydrateFromThreadRead keeps sub-agent running after timed-out wait with pending snapshot", () => {
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    items: [
      {
        type: "toolCall",
        itemId: "tool:tc-spawn-1",
        toolCallId: "tc-spawn-1",
        toolName: "spawn_agent",
        input: { description: "do work" },
        output: JSON.stringify({ thread_id: "ses-child-1", nickname: "Cleo" }),
        isError: false,
        timestamp: 101,
        startedAt: 100,
        durationMs: 1,
      },
      {
        type: "toolCall",
        itemId: "tool:tc-wait-1",
        toolCallId: "tc-wait-1",
        toolName: "wait",
        input: { ids: ["ses-child-1"] },
        output: JSON.stringify({
          status: {
            "ses-child-1": { kind: "pending" },
          },
          timed_out: true,
        }),
        isError: false,
        timestamp: 102,
        startedAt: 101,
        durationMs: 1,
      },
    ],
    isRunning: false,
    hasFollowUp: false,
    entryCount: 3,
    currentEffort: "medium",
  });

  const collab = hydrated.items.find((item) => item.kind === "collab" && item.eventType === "spawn");
  expect(collab).toBeDefined();
  expect(collab && collab.kind === "collab" ? collab.status : "").toBe("running");
});

test("hydrateFromThreadRead stores full wait message text from status output", () => {
  const veryLongMessage = `${"x".repeat(300)}\nline2`;
  const hydrated = hydrateFromThreadRead(initialThreadState, {
    items: [
      {
        type: "toolCall",
        itemId: "tool:tc-wait-1",
        toolCallId: "tc-wait-1",
        toolName: "wait",
        input: { ids: ["ses-child-1"] },
        output: JSON.stringify({
          status: {
            "ses-child-1": { kind: "completed", output: veryLongMessage },
          },
          timed_out: false,
        }),
        isError: false,
        timestamp: 102,
        startedAt: 101,
        durationMs: 1,
      },
    ],
    isRunning: false,
    hasFollowUp: false,
    entryCount: 1,
    currentEffort: "medium",
  });

  const collabWait = hydrated.items.find((item) => item.kind === "collab" && item.eventType === "wait");
  expect(collabWait).toBeDefined();
  const firstAgent = collabWait && collabWait.kind === "collab" ? collabWait.agents?.[0] : undefined;
  expect(firstAgent?.message).toBe(veryLongMessage);
});
