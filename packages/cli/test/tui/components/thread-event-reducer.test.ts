// @summary Unit tests for pure ThreadStore event reducer transitions
import { describe, expect, test } from "bun:test";
import { reduceThreadEvent, type ThreadEventReducerState } from "../../../src/tui/components/thread-event-reducer";
import {
  buildToolEndItem,
  deriveToolStartState,
  deriveToolUpdateMessage,
} from "../../../src/tui/components/thread-store-utils";

type TestItem = { id: string };

function createState(overrides?: Partial<ThreadEventReducerState<TestItem>>): ThreadEventReducerState<TestItem> {
  return {
    items: [],
    thinkingStartTime: null,
    thinkingText: "",
    overlayStatus: null,
    statusBeforeCompaction: null,
    isThreadBusy: false,
    busyStartedAt: null,
    lastUsage: null,
    planCallCount: 0,
    hasCommittedAssistantChunkInMessage: false,
    toolCalls: {},
    collabByToolCallId: {},
    collabAgentNamesByThreadId: {},
    ...overrides,
  };
}

function createDeps(nowMs = 1, markdownText = "") {
  return {
    nowMs,
    getCommittedMarkdownText: () => markdownText,
    deriveToolStartState,
    deriveToolUpdateMessage,
    buildCompactionItem: () => ({ id: "compaction" }),
    buildKnowledgeSavedItem: () => ({ id: "knowledge" }),
    buildErrorItem: () => ({ id: "error" }),
    buildThinkingItem: (_text: string) => ({ id: "thinking" }),
    buildAssistantChunkItem: (_text: string, _continued: boolean) => ({ id: "assistant" }),
    buildToolEndItem: (options: Parameters<typeof buildToolEndItem>[0]) => {
      const built = buildToolEndItem(options);
      return {
        item: { id: `tool:${built.planCallCount}` },
        collabAgentNamesByThreadId: built.collabAgentNamesByThreadId,
        planCallCount: built.planCallCount,
      };
    },
  };
}

describe("reduceThreadEvent", () => {
  test("handles status_change busy by setting busyStartedAt once", () => {
    const nowMs = 1700000000000;
    const first = reduceThreadEvent(createState(), { type: "status_change", status: "busy" }, createDeps(nowMs));

    expect(first.handled).toBe(true);
    expect(first.requestRender).toBe(true);
    expect(first.state.isThreadBusy).toBe(true);
    expect(first.state.busyStartedAt).toBe(nowMs);
    expect(first.effects).toEqual([{ kind: "start_status_timers" }]);

    const second = reduceThreadEvent(first.state, { type: "status_change", status: "busy" }, createDeps(nowMs + 999));
    expect(second.state.busyStartedAt).toBe(nowMs);
  });

  test("handles compaction_end by restoring previous overlay and appending item", () => {
    const result = reduceThreadEvent(
      createState({
        overlayStatus: { message: "Compacting…", kind: "default", startedAt: 1000 },
        statusBeforeCompaction: "Thinking…",
      }),
      { type: "compaction_end", summary: "trimmed", tokensBefore: 4000, tokensAfter: 1800 },
      { ...createDeps(2000), buildCompactionItem: () => ({ id: "compaction-item" }) },
    );

    expect(result.handled).toBe(true);
    expect(result.state.statusBeforeCompaction).toBeNull();
    expect(result.state.overlayStatus?.message).toBe("Thinking…");
    expect(result.state.items).toEqual([{ id: "compaction-item" }]);
  });

  test("error clears busy and compaction state immediately", () => {
    const result = reduceThreadEvent(
      createState({
        overlayStatus: { message: "Compacting…", kind: "default", startedAt: 1000 },
        statusBeforeCompaction: "Thinking…",
        isThreadBusy: true,
        busyStartedAt: 1000,
      }),
      { type: "error", error: { message: "too small", name: "Error" }, fatal: false },
      createDeps(2000),
    );

    expect(result.handled).toBe(true);
    expect(result.state.isThreadBusy).toBe(false);
    expect(result.state.busyStartedAt).toBeNull();
    expect(result.state.statusBeforeCompaction).toBeNull();
    expect(result.state.overlayStatus).toBeNull();
    expect(result.state.items).toEqual([{ id: "error" }]);
  });

  test("message_start resets assistant-stream state and opens markdown via effects", () => {
    const initial = createState();
    const result = reduceThreadEvent(initial, { type: "message_start" }, createDeps());

    expect(result.handled).toBe(true);
    expect(result.requestRender).toBe(true);
    expect(result.effects).toEqual([{ kind: "markdown_open" }, { kind: "cleanup_status_timers_if_idle" }]);
    expect(result.state.hasCommittedAssistantChunkInMessage).toBe(false);
  });

  test("text delta commits thinking item before markdown push", () => {
    const result = reduceThreadEvent(
      createState({ thinkingText: "pondering", thinkingStartTime: 10 }),
      { type: "message_delta", delta: { type: "text_delta", delta: "hello" } },
      { ...createDeps(20), buildThinkingItem: (_text: string) => ({ id: "thinking-committed" }) },
    );

    expect(result.state.items).toEqual([{ id: "thinking-committed" }]);
    expect(result.effects).toEqual([
      { kind: "markdown_push", delta: "hello" },
      { kind: "cleanup_status_timers_if_idle" },
    ]);
    expect(result.state.thinkingText).toBe("");
  });

  test("tool lifecycle is reduced without delegates", () => {
    const started = reduceThreadEvent(
      createState({ collabAgentNamesByThreadId: { child: "Holly" } }),
      { type: "tool_start", toolName: "wait", toolCallId: "wait_1", input: { ids: ["child"] } },
      createDeps(100),
    );

    expect(started.state.overlayStatus?.message).toContain("Waiting for Holly");
    expect(started.state.toolCalls.wait_1?.startedAt).toBe(100);

    const updated = reduceThreadEvent(
      started.state,
      { type: "tool_update", toolName: "wait", toolCallId: "wait_1", partialResult: "Complete" },
      createDeps(120),
    );
    expect(updated.state.overlayStatus?.message).toContain("Complete");

    const ended = reduceThreadEvent(
      updated.state,
      {
        type: "tool_end",
        toolName: "wait",
        toolCallId: "wait_1",
        output: JSON.stringify({ summary: [] }),
        isError: false,
      },
      createDeps(140),
    );
    expect(ended.state.overlayStatus).toBeNull();
    expect(ended.state.toolCalls.wait_1).toBeUndefined();
    expect(ended.state.items).toEqual([{ id: "tool:0" }]);
  });

  test("spawn_agent completion preserves hyphenated custom agent type labels", () => {
    const built = buildToolEndItem({
      event: {
        type: "tool_end",
        toolName: "spawn_agent",
        toolCallId: "spawn_1",
        output: JSON.stringify({ thread_id: "child-1", nickname: "Acacia" }),
        isError: false,
      },
      toolCall: {
        startedAt: 100,
      },
      collabState: {
        toolName: "spawn_agent",
        label: "Spawning [code-reviewer] custom reviewer…",
        prompt: "Review this change",
      },
      planCallCount: 0,
      collabAgentNamesByThreadId: {},
      nowMs: 200,
    });

    expect(built.item.kind).toBe("tool_result");
    if (built.item.kind !== "tool_result") return;
    expect(built.item.header).toContain("[code-reviewer]");
  });
});
