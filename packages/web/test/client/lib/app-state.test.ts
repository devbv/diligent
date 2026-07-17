// @summary Tests for app-level reducer behavior extracted from App orchestrator

import { expect, test } from "bun:test";
import { appReducer } from "../../../src/client/lib/app-state";
import { initialThreadState } from "../../../src/client/lib/thread-store";
import { resolveDraftModel } from "../../../src/client/lib/use-provider-manager";

test("set_threads keeps optimistic first message when server value is empty", () => {
  const seeded = {
    ...initialThreadState,
    threadList: [
      {
        id: "t1",
        path: "",
        cwd: "",
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-01T00:00:00.000Z",
        messageCount: 1,
        firstUserMessage: "hello optimistic",
      },
    ],
  };

  const next = appReducer(seeded, {
    type: "set_threads",
    payload: [
      {
        id: "t1",
        path: "",
        cwd: "",
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-02T00:00:00.000Z",
        messageCount: 1,
      },
    ],
  });

  expect(next.threadList[0]?.firstUserMessage).toBe("hello optimistic");
});

test("set_threads keeps optimistic thread not yet returned by server", () => {
  const seeded = {
    ...initialThreadState,
    threadList: [
      {
        id: "optimistic-only",
        path: "",
        cwd: "",
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-01T00:00:00.000Z",
        messageCount: 1,
        firstUserMessage: "just sent",
      },
      {
        id: "existing",
        path: "",
        cwd: "",
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-01T00:00:00.000Z",
        messageCount: 2,
        firstUserMessage: "older",
      },
    ],
  };

  const next = appReducer(seeded, {
    type: "set_threads",
    payload: [
      {
        id: "existing",
        path: "",
        cwd: "",
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-02T00:00:00.000Z",
        messageCount: 2,
        firstUserMessage: "older",
      },
    ],
  });

  expect(next.threadList.map((thread) => thread.id)).toEqual(["optimistic-only", "existing"]);
  expect(next.threadList[0]?.firstUserMessage).toBe("just sent");
});

test("set_threads drops stale legacy optimistic-like thread from top", () => {
  const seeded = {
    ...initialThreadState,
    threadList: [
      {
        id: "legacy-thread",
        path: "/repo/.diligent/sessions/legacy-thread.jsonl",
        cwd: "/repo",
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-03T00:00:00.000Z",
        messageCount: 5,
        firstUserMessage: "older discussion",
      },
      {
        id: "server-top",
        path: "/repo/.diligent/sessions/server-top.jsonl",
        cwd: "/repo",
        created: "2026-01-02T00:00:00.000Z",
        modified: "2026-01-02T00:00:00.000Z",
        messageCount: 2,
        firstUserMessage: "newer on server",
      },
    ],
  };

  const next = appReducer(seeded, {
    type: "set_threads",
    payload: [
      {
        id: "server-top",
        path: "/repo/.diligent/sessions/server-top.jsonl",
        cwd: "/repo",
        created: "2026-01-02T00:00:00.000Z",
        modified: "2026-01-02T00:00:00.000Z",
        messageCount: 2,
        firstUserMessage: "newer on server",
      },
    ],
  });

  expect(next.threadList.map((thread) => thread.id)).toEqual(["server-top"]);
});

test("set_threads hides empty pre-message conversations", () => {
  const next = appReducer(initialThreadState, {
    type: "set_threads",
    payload: [
      {
        id: "empty-thread",
        path: "/repo/.diligent/sessions/empty-thread.jsonl",
        cwd: "/repo",
        created: "2026-01-02T00:00:00.000Z",
        modified: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
      },
      {
        id: "active-thread",
        path: "/repo/.diligent/sessions/active-thread.jsonl",
        cwd: "/repo",
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-03T00:00:00.000Z",
        messageCount: 3,
        firstUserMessage: "hello",
      },
    ],
  });

  expect(next.threadList.map((thread) => thread.id)).toEqual(["active-thread"]);
});

test("optimistic_thread prepends a new thread when absent", () => {
  const next = appReducer(initialThreadState, {
    type: "optimistic_thread",
    payload: { threadId: "t-new", message: "first message" },
  });

  expect(next.threadList[0]?.id).toBe("t-new");
  expect(next.threadList[0]?.firstUserMessage).toBe("first message");
  expect(next.threadList[0]?.messageCount).toBe(1);
});

test("optimistic_thread updates existing thread missing first message", () => {
  const seeded = {
    ...initialThreadState,
    threadList: [
      {
        id: "t1",
        path: "",
        cwd: "",
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-01T00:00:00.000Z",
        messageCount: 0,
      },
    ],
  };

  const next = appReducer(seeded, {
    type: "optimistic_thread",
    payload: { threadId: "t1", message: "seeded now" },
  });

  expect(next.threadList).toHaveLength(1);
  expect(next.threadList[0]?.firstUserMessage).toBe("seeded now");
});

test("reset_draft clears active thread and items but preserves thread list", () => {
  const seeded = {
    ...initialThreadState,
    activeThreadId: "t1",
    activeThreadCwd: "/repo",
    mode: "plan" as const,
    items: [
      {
        id: "local-user-1",
        kind: "user" as const,
        text: "hello",
        images: [],
        timestamp: 1,
      },
    ],
    threadList: [
      {
        id: "t1",
        path: "",
        cwd: "/repo",
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-01T00:00:00.000Z",
        messageCount: 1,
        firstUserMessage: "hello",
      },
    ],
  };

  const next = appReducer(seeded, {
    type: "reset_draft",
    payload: { mode: "execute" },
  });

  expect(next.activeThreadId).toBeNull();
  expect(next.items).toEqual([]);
  expect(next.mode).toBe("execute");
  expect(next.threadList).toEqual(seeded.threadList);
});

test("hydrate prefers restored thread mode from thread/read history", () => {
  const next = appReducer(
    {
      ...initialThreadState,
      mode: "default",
    },
    {
      type: "hydrate",
      payload: {
        threadId: "thread-1",
        mode: "default",
        history: {
          cwd: "/repo",
          items: [],
          hasFollowUp: false,
          entryCount: 1,
          isRunning: false,
          currentMode: "plan",
          currentEffort: "medium",
          currentModel: "gpt-5",
        },
      },
    },
  );

  expect(next.activeThreadId).toBe("thread-1");
  expect(next.mode).toBe("plan");
});

test("hydrate resets mode when switching from a plan thread to a default thread", () => {
  const next = appReducer(
    {
      ...initialThreadState,
      activeThreadId: "plan-thread",
      activeThreadCwd: "/repo",
      mode: "plan",
    },
    {
      type: "hydrate",
      payload: {
        threadId: "default-thread",
        mode: "default",
        history: {
          cwd: "/repo",
          items: [],
          hasFollowUp: false,
          entryCount: 1,
          isRunning: false,
          currentMode: "default",
          currentEffort: "medium",
          currentModel: "gpt-5",
        },
      },
    },
  );

  expect(next.activeThreadId).toBe("default-thread");
  expect(next.mode).toBe("default");
});

test("consume_first_pending_steer removes head entry only", () => {
  const seeded = {
    ...initialThreadState,
    pendingSteers: [
      { id: "s1", content: "a" },
      { id: "s2", content: "b" },
      { id: "s3", content: "c" },
    ],
  };

  const next = appReducer(seeded, { type: "consume_first_pending_steer" });

  expect(next.pendingSteers.map((steer) => steer.content)).toEqual(["b", "c"]);
});

test("cancel_pending_steer removes the selected queued steer", () => {
  const seeded = {
    ...initialThreadState,
    pendingSteers: [
      { id: "s1", content: "a" },
      { id: "s2", content: "b" },
      { id: "s3", content: "c" },
    ],
  };

  const next = appReducer(seeded, { type: "cancel_pending_steer", payload: { steerId: "s2" } });

  expect(next.pendingSteers.map((steer) => steer.content)).toEqual(["a", "c"]);
});

test("update_pending_steer replaces the selected queued steer", () => {
  const seeded = {
    ...initialThreadState,
    pendingSteers: [
      { id: "s1", content: "a" },
      { id: "s2", content: "b" },
      { id: "s3", content: "c" },
    ],
  };

  const next = appReducer(seeded, {
    type: "update_pending_steer",
    payload: { steerId: "s2", content: "updated" },
  });

  expect(next.pendingSteers.map((steer) => steer.content)).toEqual(["a", "updated", "c"]);
});

test("local_steer queues steer text without creating a local user item", () => {
  const next = appReducer(initialThreadState, {
    type: "local_steer",
    payload: { id: "s1", content: "adjust plan" },
  });

  expect(next.pendingSteers).toEqual([{ id: "s1", content: "adjust plan" }]);
  expect(next.items).toEqual([]);
});

test("compaction_error clears compacting state", () => {
  const next = appReducer(
    {
      ...initialThreadState,
      isCompacting: true,
    },
    { type: "compaction_error" },
  );

  expect(next.isCompacting).toBe(false);
});

test("resolveDraftModel preserves the current user-selected model when available", () => {
  const next = resolveDraftModel({
    initialModel: "gpt-5",
    currentModel: "claude-sonnet",
    availableModels: [
      { id: "claude-sonnet", provider: "anthropic" },
      { id: "gpt-5", provider: "openai" },
    ],
  });

  expect(next).toBe("claude-sonnet");
});

test("resolveDraftModel falls back to initial model when current model is unavailable", () => {
  const next = resolveDraftModel({
    initialModel: "gpt-5",
    currentModel: "claude-sonnet",
    availableModels: [{ id: "gpt-5", provider: "openai" }],
  });

  expect(next).toBe("gpt-5");
});

test("resolveDraftModel prefers the runtime default over catalog order", () => {
  const next = resolveDraftModel({
    initialModel: "gpt-5.6-sol",
    currentModel: "",
    availableModels: [
      { id: "gpt-5.6-terra", provider: "openai" },
      { id: "gpt-5.6-sol", provider: "openai" },
    ],
  });

  expect(next).toBe("gpt-5.6-sol");
});
