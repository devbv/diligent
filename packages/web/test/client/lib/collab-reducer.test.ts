// @summary Dedicated unit tests for collab-reducer pure functions
import { expect, test } from "bun:test";
import type { CollabAgentEvent } from "../../../src/client/lib/collab-reducer";
import {
  appendChildAssistantTimelineDelta,
  appendChildAssistantTimelineStart,
  finalizeChildAssistantTimeline,
  findCollabSpawnItem,
  isCollabEvent,
  reduceCollabEvent,
} from "../../../src/client/lib/collab-reducer";
import type { ThreadState } from "../../../src/client/lib/thread-store";
import { initialThreadState } from "../../../src/client/lib/thread-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ThreadState that includes a collab spawn item for childThreadId. */
function stateWithSpawn(childThreadId: string): ThreadState {
  const spawnEvent: CollabAgentEvent = {
    type: "collab_spawn_begin",
    callId: childThreadId,
    prompt: "Do something",
    agentType: "default",
  };
  return reduceCollabEvent(initialThreadState, spawnEvent);
}

// ---------------------------------------------------------------------------
// isCollabEvent
// ---------------------------------------------------------------------------

test("isCollabEvent returns true for collab_ prefixed events", () => {
  const events: CollabAgentEvent[] = [
    { type: "collab_spawn_begin", callId: "c1", prompt: "p", agentType: "x" },
    { type: "collab_close_begin", callId: "c1", childThreadId: "t1" },
    { type: "collab_interaction_begin", callId: "c1", receiverThreadId: "t1", prompt: "p" },
  ];
  for (const e of events) {
    expect(isCollabEvent(e)).toBe(true);
  }
});

test("isCollabEvent returns false for non-collab events", () => {
  expect(isCollabEvent({ type: "tool_start", itemId: "i1", toolCallId: "tc1", toolName: "bash", input: {} })).toBe(
    false,
  );
  expect(isCollabEvent({ type: "status_change", status: "idle" })).toBe(false);
});

// ---------------------------------------------------------------------------
// findCollabSpawnItem
// ---------------------------------------------------------------------------

test("findCollabSpawnItem returns undefined on empty state", () => {
  expect(findCollabSpawnItem(initialThreadState, "thread1")).toBeUndefined();
});

test("findCollabSpawnItem finds spawn item by childThreadId", () => {
  const state = stateWithSpawn("thread1");
  const found = findCollabSpawnItem(state, "thread1");
  expect(found).toBeDefined();
  expect(found?.kind).toBe("collab");
  expect(found?.eventType).toBe("spawn");
  expect(found?.childThreadId).toBe("thread1");
});

test("findCollabSpawnItem returns undefined when childThreadId does not match", () => {
  const state = stateWithSpawn("thread1");
  expect(findCollabSpawnItem(state, "other-thread")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// reduceCollabEvent — collab_spawn_begin
// ---------------------------------------------------------------------------

test("collab_spawn_begin adds a collab spawn item with running status", () => {
  const event: CollabAgentEvent = {
    type: "collab_spawn_begin",
    callId: "call-abc",
    prompt: "Build a feature",
    agentType: "engineer",
  };
  const next = reduceCollabEvent(initialThreadState, event);
  expect(next.items).toHaveLength(1);
  const item = next.items[0];
  expect(item.kind).toBe("collab");
  if (item.kind === "collab") {
    expect(item.eventType).toBe("spawn");
    expect(item.childThreadId).toBe("call-abc");
    expect(item.agentType).toBe("engineer");
    expect(item.prompt).toBe("Build a feature");
    expect(item.status).toBe("running");
    expect(item.childTools).toEqual([]);
    expect(item.childTimeline).toEqual([]);
  }
});

test("collab_spawn_begin is idempotent — duplicate callId does not add second item", () => {
  const event: CollabAgentEvent = {
    type: "collab_spawn_begin",
    callId: "call-dup",
    prompt: "p",
    agentType: "x",
  };
  const s1 = reduceCollabEvent(initialThreadState, event);
  const s2 = reduceCollabEvent(s1, event);
  expect(s2.items).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// reduceCollabEvent — collab_spawn_end
// ---------------------------------------------------------------------------

test("collab_spawn_end updates existing spawn item with final data", () => {
  // callId from spawn_begin becomes the initial childThreadId; spawn_end must use the same value
  // as childThreadId so findCollabSpawnItem locates the existing item for update.
  const state = stateWithSpawn("call-xyz");
  const event: CollabAgentEvent = {
    type: "collab_spawn_end",
    callId: "call-xyz",
    childThreadId: "call-xyz", // matches the initial childThreadId set by spawn_begin
    nickname: "Worker",
    agentType: "default",
    description: "Handles the task",
    prompt: "Do the thing",
    status: "completed",
    message: "Done",
  };
  const next = reduceCollabEvent(state, event);
  const item = findCollabSpawnItem(next, "call-xyz");
  expect(item).toBeDefined();
  if (item) {
    expect(item.nickname).toBe("Worker");
    expect(item.status).toBe("completed");
    expect(item.message).toBe("Done");
    expect(item.description).toBe("Handles the task");
  }
});

test("collab_spawn_end creates item when no prior spawn_begin", () => {
  const event: CollabAgentEvent = {
    type: "collab_spawn_end",
    callId: "call-fresh",
    childThreadId: "thread-fresh",
    nickname: "Fresh",
    prompt: "Go",
    status: "running",
  };
  const next = reduceCollabEvent(initialThreadState, event);
  expect(next.items).toHaveLength(1);
  const item = next.items[0];
  expect(item.kind).toBe("collab");
  if (item.kind === "collab") {
    expect(item.childThreadId).toBe("thread-fresh");
    expect(item.nickname).toBe("Fresh");
  }
});

// ---------------------------------------------------------------------------
// reduceCollabEvent — collab_wait_begin
// ---------------------------------------------------------------------------

test("collab_wait_begin adds a collab wait item with running status", () => {
  const event: CollabAgentEvent = {
    type: "collab_wait_begin",
    callId: "wait-1",
    agents: [
      { threadId: "t1", nickname: "A" },
      { threadId: "t2", nickname: "B" },
    ],
  };
  const next = reduceCollabEvent(initialThreadState, event);
  expect(next.items).toHaveLength(1);
  const item = next.items[0];
  expect(item.kind).toBe("collab");
  if (item.kind === "collab") {
    expect(item.eventType).toBe("wait");
    expect(item.status).toBe("running");
    expect(item.agents).toHaveLength(2);
    expect(item.timedOut).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// reduceCollabEvent — collab_wait_end
// ---------------------------------------------------------------------------

test("collab_wait_end updates wait item to completed when not timed out", () => {
  const beginEvent: CollabAgentEvent = {
    type: "collab_wait_begin",
    callId: "wait-2",
    agents: [{ threadId: "t1", nickname: "A" }],
  };
  const s1 = reduceCollabEvent(initialThreadState, beginEvent);

  const endEvent: CollabAgentEvent = {
    type: "collab_wait_end",
    callId: "wait-2",
    agentStatuses: [{ threadId: "t1", nickname: "A", status: "completed", message: "ok" }],
    timedOut: false,
  };
  const next = reduceCollabEvent(s1, endEvent);
  const item = next.items.find((i) => i.kind === "collab" && i.id === "collab:wait:wait-2");
  expect(item).toBeDefined();
  if (item?.kind === "collab") {
    expect(item.status).toBe("completed");
    expect(item.timedOut).toBe(false);
  }
});

test("collab_wait_end keeps status running when timed out", () => {
  const beginEvent: CollabAgentEvent = {
    type: "collab_wait_begin",
    callId: "wait-3",
    agents: [{ threadId: "t1", nickname: "A" }],
  };
  const s1 = reduceCollabEvent(initialThreadState, beginEvent);

  const endEvent: CollabAgentEvent = {
    type: "collab_wait_end",
    callId: "wait-3",
    agentStatuses: [{ threadId: "t1", nickname: "A", status: "running" }],
    timedOut: true,
  };
  const next = reduceCollabEvent(s1, endEvent);
  const item = next.items.find((i) => i.kind === "collab" && i.id === "collab:wait:wait-3");
  if (item?.kind === "collab") {
    expect(item.status).toBe("running");
    expect(item.timedOut).toBe(true);
  }
});

test("collab_wait_end updates spawn item status for each agent", () => {
  // Set up a spawn item for "t1"
  const spawnBegin: CollabAgentEvent = {
    type: "collab_spawn_begin",
    callId: "t1",
    prompt: "p",
    agentType: "x",
  };
  const s0 = reduceCollabEvent(initialThreadState, spawnBegin);

  const waitBegin: CollabAgentEvent = {
    type: "collab_wait_begin",
    callId: "w1",
    agents: [{ threadId: "t1", nickname: "A" }],
  };
  const s1 = reduceCollabEvent(s0, waitBegin);

  const waitEnd: CollabAgentEvent = {
    type: "collab_wait_end",
    callId: "w1",
    agentStatuses: [{ threadId: "t1", nickname: "A", status: "completed", message: "done" }],
    timedOut: false,
  };
  const next = reduceCollabEvent(s1, waitEnd);
  const spawnItem = findCollabSpawnItem(next, "t1");
  expect(spawnItem?.status).toBe("completed");
  expect(spawnItem?.message).toBe("done");
});

// ---------------------------------------------------------------------------
// reduceCollabEvent — collab_close_begin / collab_close_end
// ---------------------------------------------------------------------------

test("collab_close_begin returns state unchanged", () => {
  const event: CollabAgentEvent = {
    type: "collab_close_begin",
    callId: "cb1",
    childThreadId: "t1",
  };
  const next = reduceCollabEvent(initialThreadState, event);
  expect(next).toBe(initialThreadState);
});

test("collab_close_end adds a close item and updates spawn status", () => {
  const s0 = stateWithSpawn("t-close");
  const event: CollabAgentEvent = {
    type: "collab_close_end",
    callId: "close-1",
    childThreadId: "t-close",
    nickname: "Closeable",
    status: "completed",
    message: "Finished",
  };
  const next = reduceCollabEvent(s0, event);
  const closeItem = next.items.find((i) => i.kind === "collab" && i.id === "collab:close:close-1");
  expect(closeItem).toBeDefined();
  if (closeItem?.kind === "collab") {
    expect(closeItem.eventType).toBe("close");
    expect(closeItem.status).toBe("completed");
    expect(closeItem.message).toBe("Finished");
    expect(closeItem.nickname).toBe("Closeable");
  }
  // spawn status updated
  const spawnItem = findCollabSpawnItem(next, "t-close");
  expect(spawnItem?.status).toBe("completed");
  expect(spawnItem?.message).toBe("Finished");
});

// ---------------------------------------------------------------------------
// reduceCollabEvent — collab_interaction_begin / collab_interaction_end
// ---------------------------------------------------------------------------

test("collab_interaction_begin returns state unchanged", () => {
  const event: CollabAgentEvent = {
    type: "collab_interaction_begin",
    callId: "ib1",
    receiverThreadId: "t1",
    prompt: "hello",
  };
  const next = reduceCollabEvent(initialThreadState, event);
  expect(next).toBe(initialThreadState);
});

test("collab_interaction_end adds an interaction item", () => {
  const event: CollabAgentEvent = {
    type: "collab_interaction_end",
    callId: "ia1",
    receiverThreadId: "t-ia",
    receiverNickname: "Receiver",
    prompt: "Do this",
    status: "completed",
  };
  const next = reduceCollabEvent(initialThreadState, event);
  expect(next.items).toHaveLength(1);
  const item = next.items[0];
  if (item.kind === "collab") {
    expect(item.eventType).toBe("interaction");
    expect(item.childThreadId).toBe("t-ia");
    expect(item.nickname).toBe("Receiver");
    expect(item.message).toBe("Do this");
    expect(item.status).toBe("completed");
  }
});

// ---------------------------------------------------------------------------
// Child assistant timeline helpers
// ---------------------------------------------------------------------------

test("appendChildAssistantTimelineStart adds an empty assistant entry", () => {
  const state = stateWithSpawn("tl-1");
  const next = appendChildAssistantTimelineStart(state, "tl-1", "msg-1");
  const spawn = findCollabSpawnItem(next, "tl-1");
  expect(spawn?.childTimeline).toHaveLength(1);
  expect(spawn?.childTimeline?.[0]).toEqual({ kind: "assistant", itemId: "msg-1", message: "" });
});

test("appendChildAssistantTimelineStart is idempotent for duplicate itemId", () => {
  let state = stateWithSpawn("tl-dup");
  state = appendChildAssistantTimelineStart(state, "tl-dup", "msg-dup");
  state = appendChildAssistantTimelineStart(state, "tl-dup", "msg-dup");
  state = appendChildAssistantTimelineStart(state, "tl-dup", "msg-dup");
  const spawn = findCollabSpawnItem(state, "tl-dup");
  expect(spawn?.childTimeline).toHaveLength(1);
  expect(spawn?.childTimeline?.[0]).toEqual({ kind: "assistant", itemId: "msg-dup", message: "" });
});

test("appendChildAssistantTimelineStart returns unchanged state when spawn not found", () => {
  const next = appendChildAssistantTimelineStart(initialThreadState, "missing");
  expect(next).toBe(initialThreadState);
});

test("appendChildAssistantTimelineDelta appends delta to last assistant entry", () => {
  let state = stateWithSpawn("tl-2");
  state = appendChildAssistantTimelineStart(state, "tl-2", "msg-2");
  state = appendChildAssistantTimelineDelta(state, "tl-2", "Hello");
  state = appendChildAssistantTimelineDelta(state, "tl-2", " world");
  const spawn = findCollabSpawnItem(state, "tl-2");
  expect(spawn?.childTimeline?.[0]).toEqual({ kind: "assistant", itemId: "msg-2", message: "Hello world" });
});

test("appendChildAssistantTimelineDelta creates assistant entry if none exists", () => {
  const state = stateWithSpawn("tl-3");
  const next = appendChildAssistantTimelineDelta(state, "tl-3", "Hi");
  const spawn = findCollabSpawnItem(next, "tl-3");
  expect(spawn?.childTimeline).toHaveLength(1);
  expect(spawn?.childTimeline?.[0]).toEqual({ kind: "assistant", message: "Hi" });
});

test("finalizeChildAssistantTimeline replaces last assistant entry with final message", () => {
  let state = stateWithSpawn("tl-4");
  state = appendChildAssistantTimelineStart(state, "tl-4", "msg-4");
  state = appendChildAssistantTimelineDelta(state, "tl-4", "partial");

  const finalMsg = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "final answer" }],
    model: "test-model",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn" as const,
    timestamp: Date.now(),
  };
  const next = finalizeChildAssistantTimeline(state, "tl-4", finalMsg);
  const spawn = findCollabSpawnItem(next, "tl-4");
  const entry = spawn?.childTimeline?.[0];
  expect(entry?.kind).toBe("assistant");
  if (entry?.kind === "assistant") {
    expect(entry.message).toContain("final answer");
  }
});
