// @summary Dedicated unit tests for tool-reducer pure functions
import { expect, test } from "bun:test";
import type { CollabAgentEvent } from "../../../src/client/lib/collab-reducer";
import { reduceCollabEvent } from "../../../src/client/lib/collab-reducer";
import type { ThreadState } from "../../../src/client/lib/thread-store";
import { initialThreadState } from "../../../src/client/lib/thread-store";
import type { ToolAgentEvent } from "../../../src/client/lib/tool-reducer";
import { isToolEvent, nextToolRenderId, reduceToolEvent } from "../../../src/client/lib/tool-reducer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a state that already has a collab spawn item for the given childThreadId. */
function stateWithCollabSpawn(childThreadId: string): ThreadState {
  const event: CollabAgentEvent = {
    type: "collab_spawn_begin",
    callId: childThreadId,
    prompt: "Do something",
    agentType: "default",
  };
  return reduceCollabEvent(initialThreadState, event);
}

/** Minimal tool_start event (top-level, no child thread). */
function toolStartEvent(
  overrides: Partial<ToolAgentEvent & { type: "tool_start" }> = {},
): Extract<ToolAgentEvent, { type: "tool_start" }> {
  return {
    type: "tool_start",
    itemId: "item-a",
    toolCallId: "tc-a",
    toolName: "bash",
    input: { command: "ls" },
    ...overrides,
  } as Extract<ToolAgentEvent, { type: "tool_start" }>;
}

// ---------------------------------------------------------------------------
// isToolEvent
// ---------------------------------------------------------------------------

test("isToolEvent returns true for tool_ prefixed events", () => {
  const events: ToolAgentEvent[] = [
    { type: "tool_start", itemId: "i1", toolCallId: "tc1", toolName: "bash", input: {} },
    { type: "tool_update", itemId: "i1", toolCallId: "tc1", toolName: "bash", partialResult: "x" },
    { type: "tool_end", itemId: "i1", toolCallId: "tc1", toolName: "bash", output: "y", isError: false },
  ];
  for (const e of events) {
    expect(isToolEvent(e)).toBe(true);
  }
});

test("isToolEvent returns false for non-tool events", () => {
  expect(isToolEvent({ type: "status_change", status: "idle" })).toBe(false);
  expect(isToolEvent({ type: "collab_spawn_begin", callId: "c1", prompt: "p", agentType: "x" })).toBe(false);
});

// ---------------------------------------------------------------------------
// nextToolRenderId
// ---------------------------------------------------------------------------

test("nextToolRenderId returns a string containing the itemId", () => {
  const id = nextToolRenderId("my-item");
  expect(id).toContain("my-item");
  expect(id.startsWith("item:my-item:")).toBe(true);
});

test("nextToolRenderId returns unique ids on successive calls", () => {
  const a = nextToolRenderId("item-x");
  const b = nextToolRenderId("item-x");
  expect(a).not.toBe(b);
});

// ---------------------------------------------------------------------------
// reduceToolEvent — tool_start (top-level)
// ---------------------------------------------------------------------------

test("tool_start adds a tool item with streaming status", () => {
  const event = toolStartEvent({ itemId: "ts-1", toolCallId: "tc-ts-1", toolName: "bash" });
  const next = reduceToolEvent(initialThreadState, event);
  expect(next.items).toHaveLength(1);
  const item = next.items[0];
  expect(item.kind).toBe("tool");
  if (item.kind === "tool") {
    expect(item.toolName).toBe("bash");
    expect(item.status).toBe("streaming");
    expect(item.isError).toBe(false);
    expect(item.outputText).toBe("");
  }
});

test("tool_start records itemId→renderId in itemSlots", () => {
  const event = toolStartEvent({ itemId: "ts-slot", toolCallId: "tc-slot" });
  const next = reduceToolEvent(initialThreadState, event);
  expect(next.itemSlots["ts-slot"]).toBeDefined();
});

test("tool_start is idempotent — duplicate itemId does not add second item", () => {
  const event = toolStartEvent({ itemId: "ts-dup", toolCallId: "tc-dup" });
  const s1 = reduceToolEvent(initialThreadState, event);
  const s2 = reduceToolEvent(s1, event);
  // Second call: itemSlots["ts-dup"] already set, so state is returned unchanged
  expect(s2.items).toHaveLength(1);
});

test("tool_start skips collab-rendered tools (spawn_agent)", () => {
  const event = toolStartEvent({ itemId: "ts-collab", toolCallId: "tc-spawn", toolName: "spawn_agent" });
  const next = reduceToolEvent(initialThreadState, event);
  expect(next.items).toHaveLength(0);
});

test("tool_start skips collab-rendered tools (wait)", () => {
  const event = toolStartEvent({ itemId: "ts-wait", toolCallId: "tc-wait", toolName: "wait" });
  const next = reduceToolEvent(initialThreadState, event);
  expect(next.items).toHaveLength(0);
});

test("tool_start skips collab-rendered tools (close_agent)", () => {
  const event = toolStartEvent({ itemId: "ts-close", toolCallId: "tc-close", toolName: "close_agent" });
  const next = reduceToolEvent(initialThreadState, event);
  expect(next.items).toHaveLength(0);
});

test("tool_start skips collab-rendered tools with namespaced name", () => {
  const event = toolStartEvent({
    itemId: "ts-collab-ns",
    toolCallId: "tc-spawn-ns",
    toolName: "overdare/spawn_agent",
  });
  const next = reduceToolEvent(initialThreadState, event);
  expect(next.items).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// reduceToolEvent — tool_update (top-level)
// ---------------------------------------------------------------------------

test("tool_update appends partialResult to outputText", () => {
  const start = toolStartEvent({ itemId: "tu-1", toolCallId: "tc-tu-1" });
  let state = reduceToolEvent(initialThreadState, start);

  const update: ToolAgentEvent = {
    type: "tool_update",
    itemId: "tu-1",
    toolCallId: "tc-tu-1",
    toolName: "bash",
    partialResult: "hello",
  };
  state = reduceToolEvent(state, update);
  const item = state.items.find((i) => i.kind === "tool");
  expect(item?.kind === "tool" ? item.outputText : "").toBe("hello");
});

test("tool_update accumulates multiple partial results", () => {
  const start = toolStartEvent({ itemId: "tu-2", toolCallId: "tc-tu-2" });
  let state = reduceToolEvent(initialThreadState, start);

  const updates: ToolAgentEvent[] = [
    { type: "tool_update", itemId: "tu-2", toolCallId: "tc-tu-2", toolName: "bash", partialResult: "a" },
    { type: "tool_update", itemId: "tu-2", toolCallId: "tc-tu-2", toolName: "bash", partialResult: "b" },
    { type: "tool_update", itemId: "tu-2", toolCallId: "tc-tu-2", toolName: "bash", partialResult: "c" },
  ];
  for (const u of updates) state = reduceToolEvent(state, u);

  const item = state.items.find((i) => i.kind === "tool");
  expect(item?.kind === "tool" ? item.outputText : "").toBe("abc");
});

test("tool_update returns state unchanged when no slot exists", () => {
  const update: ToolAgentEvent = {
    type: "tool_update",
    itemId: "unknown",
    toolCallId: "tc-unknown",
    toolName: "bash",
    partialResult: "x",
  };
  const next = reduceToolEvent(initialThreadState, update);
  expect(next).toBe(initialThreadState);
});

// ---------------------------------------------------------------------------
// reduceToolEvent — tool_end (top-level)
// ---------------------------------------------------------------------------

test("tool_end marks item as done with final output", () => {
  const start = toolStartEvent({ itemId: "te-1", toolCallId: "tc-te-1" });
  let state = reduceToolEvent(initialThreadState, start);

  const end: ToolAgentEvent = {
    type: "tool_end",
    itemId: "te-1",
    toolCallId: "tc-te-1",
    toolName: "bash",
    output: "final output",
    isError: false,
  };
  state = reduceToolEvent(state, end);
  const item = state.items.find((i) => i.kind === "tool");
  expect(item?.kind === "tool" ? item.status : "").toBe("done");
  expect(item?.kind === "tool" ? item.outputText : "").toBe("final output");
  expect(item?.kind === "tool" ? item.isError : true).toBe(false);
});

test("tool_end clears the itemSlot after completion", () => {
  const start = toolStartEvent({ itemId: "te-2", toolCallId: "tc-te-2" });
  let state = reduceToolEvent(initialThreadState, start);
  expect(state.itemSlots["te-2"]).toBeDefined();

  const end: ToolAgentEvent = {
    type: "tool_end",
    itemId: "te-2",
    toolCallId: "tc-te-2",
    toolName: "bash",
    output: "done",
    isError: false,
  };
  state = reduceToolEvent(state, end);
  expect(state.itemSlots["te-2"]).toBeUndefined();
});

test("tool_end marks item as error when isError is true", () => {
  const start = toolStartEvent({ itemId: "te-err", toolCallId: "tc-err" });
  let state = reduceToolEvent(initialThreadState, start);

  const end: ToolAgentEvent = {
    type: "tool_end",
    itemId: "te-err",
    toolCallId: "tc-err",
    toolName: "bash",
    output: "error message",
    isError: true,
  };
  state = reduceToolEvent(state, end);
  const item = state.items.find((i) => i.kind === "tool");
  expect(item?.kind === "tool" ? item.isError : false).toBe(true);
  expect(item?.kind === "tool" ? item.status : "").toBe("done");
});

test("tool_end updates plan state for namespaced plan tool", () => {
  const start = toolStartEvent({ itemId: "te-plan-ns", toolCallId: "tc-plan-ns", toolName: "functions.plan" });
  let state = reduceToolEvent(initialThreadState, start);

  const end: ToolAgentEvent = {
    type: "tool_end",
    itemId: "te-plan-ns",
    toolCallId: "tc-plan-ns",
    toolName: "functions.plan",
    output: JSON.stringify({
      title: "Plan",
      steps: [{ text: "step 1", status: "pending" }],
    }),
    isError: false,
  };
  state = reduceToolEvent(state, end);

  expect(state.planState?.title).toBe("Plan");
  expect(state.planState?.steps).toHaveLength(1);
});

test("tool_end returns state unchanged when renderId not found", () => {
  const end: ToolAgentEvent = {
    type: "tool_end",
    itemId: "missing",
    toolCallId: "tc-missing",
    toolName: "bash",
    output: "x",
    isError: false,
  };
  const next = reduceToolEvent(initialThreadState, end);
  expect(next).toBe(initialThreadState);
});

// ---------------------------------------------------------------------------
// reduceToolEvent — child thread tools (childThreadId present)
// ---------------------------------------------------------------------------

test("tool_start with childThreadId adds tool to collab item's childTools", () => {
  const state = stateWithCollabSpawn("child-t1");
  const event: ToolAgentEvent = {
    type: "tool_start",
    itemId: "child-item-1",
    toolCallId: "child-tc-1",
    toolName: "bash",
    input: { command: "echo hi" },
    childThreadId: "child-t1",
  };
  const next = reduceToolEvent(state, event);
  // No new top-level items
  expect(next.items).toHaveLength(1);
  const collabItem = next.items[0];
  if (collabItem.kind === "collab") {
    expect(collabItem.childTools).toHaveLength(1);
    expect(collabItem.childTools[0].toolCallId).toBe("child-tc-1");
    expect(collabItem.childTools[0].status).toBe("running");
    expect(collabItem.childTimeline).toHaveLength(1);
    expect(collabItem.childTimeline?.[0].kind).toBe("tool");
  }
});

test("tool_start with childThreadId is idempotent for duplicate toolCallId", () => {
  let state = stateWithCollabSpawn("child-dup");
  const event: ToolAgentEvent = {
    type: "tool_start",
    itemId: "child-item-dup",
    toolCallId: "child-tc-dup",
    toolName: "ls",
    input: { path: "/Users/devbv/git" },
    childThreadId: "child-dup",
  };

  state = reduceToolEvent(state, event);
  state = reduceToolEvent(state, event);
  state = reduceToolEvent(state, event);

  const collabItem = state.items[0];
  expect(collabItem.kind).toBe("collab");
  if (collabItem.kind === "collab") {
    expect(collabItem.childTools).toHaveLength(1);
    expect(collabItem.childTimeline).toHaveLength(1);
    expect(collabItem.childTimeline?.[0]).toMatchObject({ kind: "tool", toolCallId: "child-tc-dup" });
  }
});

test("tool_start with childThreadId returns state unchanged when spawn not found", () => {
  const event: ToolAgentEvent = {
    type: "tool_start",
    itemId: "orphan",
    toolCallId: "tc-orphan",
    toolName: "bash",
    input: {},
    childThreadId: "no-such-thread",
  };
  const next = reduceToolEvent(initialThreadState, event);
  expect(next).toBe(initialThreadState);
});

test("tool_update with childThreadId appends partialResult to child tool output", () => {
  let state = stateWithCollabSpawn("child-t2");
  const start: ToolAgentEvent = {
    type: "tool_start",
    itemId: "ci-2",
    toolCallId: "ctc-2",
    toolName: "bash",
    input: {},
    childThreadId: "child-t2",
  };
  state = reduceToolEvent(state, start);

  const update: ToolAgentEvent = {
    type: "tool_update",
    itemId: "ci-2",
    toolCallId: "ctc-2",
    toolName: "bash",
    partialResult: "partial",
    childThreadId: "child-t2",
  };
  state = reduceToolEvent(state, update);

  const collab = state.items[0];
  if (collab.kind === "collab") {
    expect(collab.childTools[0].outputText).toBe("partial");
  }
});

test("tool_end with childThreadId marks child tool as done", () => {
  let state = stateWithCollabSpawn("child-t3");
  const start: ToolAgentEvent = {
    type: "tool_start",
    itemId: "ci-3",
    toolCallId: "ctc-3",
    toolName: "bash",
    input: {},
    childThreadId: "child-t3",
  };
  state = reduceToolEvent(state, start);

  const end: ToolAgentEvent = {
    type: "tool_end",
    itemId: "ci-3",
    toolCallId: "ctc-3",
    toolName: "bash",
    output: "result",
    isError: false,
    childThreadId: "child-t3",
  };
  state = reduceToolEvent(state, end);

  const collab = state.items[0];
  if (collab.kind === "collab") {
    expect(collab.childTools[0].status).toBe("done");
    expect(collab.childTools[0].outputText).toBe("result");
    expect(collab.childTimeline?.[0]).toMatchObject({ kind: "tool", status: "done", outputText: "result" });
  }
});
