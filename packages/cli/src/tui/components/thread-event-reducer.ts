// @summary Pure event-to-state reducer for CLI ThreadStore transitions and lifecycle effects

import type { AgentEvent, ConversationLiveState } from "@diligent/protocol";
import { applyAgentEvents } from "@diligent/protocol";
import type { CollabToolState, ToolCallState } from "./thread-store-utils";

export type ReducerOverlayStatusKind = "default" | "tool";

export interface ReducerOverlayStatus {
  message: string;
  startedAt: number;
  kind: ReducerOverlayStatusKind;
}

export interface ThreadEventReducerState<TItem> {
  items: TItem[];
  thinkingStartTime: number | null;
  thinkingText: string;
  overlayStatus: ReducerOverlayStatus | null;
  statusBeforeCompaction: string | null;
  threadStatus: string | null;
  isThreadBusy: boolean;
  busyStartedAt: number | null;
  lastUsage: { input: number; output: number; cost: number } | null;
  planCallCount: number;
  hasCommittedAssistantChunkInMessage: boolean;
  toolCalls: Record<string, ToolCallState>;
  collabByToolCallId: Record<string, CollabToolState>;
  collabAgentNamesByThreadId: Record<string, string>;
}

interface ThreadEventReducerDeps<TItem> {
  nowMs: number;
  getCommittedMarkdownText: () => string;
  deriveToolStartState: (
    event: Extract<AgentEvent, { type: "tool_start" }>,
    options: {
      planCallCount: number;
      collabAgentNamesByThreadId: Record<string, string>;
    },
  ) => { overlayMessage: string; collabState?: CollabToolState };
  deriveToolUpdateMessage: (
    event: Extract<AgentEvent, { type: "tool_update" }>,
    collabState?: CollabToolState,
  ) => string;
  buildCompactionItem: (event: Extract<AgentEvent, { type: "compaction_end" }>) => TItem;
  buildKnowledgeSavedItem: () => TItem;
  buildErrorItem: (message: string) => TItem;
  buildThinkingItem: (text: string, elapsedMs?: number) => TItem;
  buildAssistantChunkItem: (text: string, continued: boolean) => TItem;
  buildToolEndItem: (options: {
    event: Extract<AgentEvent, { type: "tool_end" }>;
    toolCall?: ToolCallState;
    collabState?: CollabToolState;
    planCallCount: number;
    collabAgentNamesByThreadId: Record<string, string>;
    nowMs: number;
  }) => { item: TItem; collabAgentNamesByThreadId: Record<string, string>; planCallCount: number };
}

export type ThreadEventReducerEffect =
  | { kind: "markdown_open" }
  | { kind: "markdown_push"; delta: string }
  | { kind: "markdown_finalize" }
  | { kind: "start_status_timers" }
  | { kind: "cleanup_status_timers_if_idle" };

export interface ThreadEventReducerResult<TItem> {
  handled: boolean;
  requestRender: boolean;
  state: ThreadEventReducerState<TItem>;
  effects: ThreadEventReducerEffect[];
}

function setOverlayStatus(
  current: ReducerOverlayStatus | null,
  message: string,
  kind: ReducerOverlayStatusKind,
  nowMs: number,
): ReducerOverlayStatus {
  if (!current) {
    return { message, kind, startedAt: nowMs };
  }

  if (current.message !== message || current.kind !== kind) {
    return { message, kind, startedAt: nowMs };
  }

  return current;
}

function extractLiveFields<TItem>(state: ThreadEventReducerState<TItem>): ConversationLiveState {
  return {
    threadId: null,
    threadTitle: null,
    threadStatus: state.threadStatus,
    items: [],
    liveText: "",
    liveThinking: "",
    liveToolName: null,
    liveToolInput: null,
    liveToolOutput: "",
    overlayStatus: null,
    isLoading: false,
    lastError: null,
  };
}

function mergeLiveFields<TItem>(
  state: ThreadEventReducerState<TItem>,
  live: ConversationLiveState,
): ThreadEventReducerState<TItem> {
  return {
    ...state,
    threadStatus: live.threadStatus,
    isThreadBusy: live.threadStatus === "busy",
  };
}

export function reduceThreadEvent<TItem>(
  state: ThreadEventReducerState<TItem>,
  event: AgentEvent,
  deps: ThreadEventReducerDeps<TItem>,
): ThreadEventReducerResult<TItem> {
  const liveResult = applyAgentEvents(extractLiveFields(state), [event]);
  const base = mergeLiveFields(state, liveResult);

  switch (event.type) {
    case "agent_start":
      return {
        handled: true,
        requestRender: true,
        effects: [{ kind: "start_status_timers" }],
        state: {
          ...base,
          overlayStatus: setOverlayStatus(state.overlayStatus, "Thinking…", "default", deps.nowMs),
        },
      };

    case "message_start":
      return {
        handled: true,
        requestRender: true,
        effects: [{ kind: "markdown_open" }, { kind: "cleanup_status_timers_if_idle" }],
        state: {
          ...base,
          overlayStatus: null,
          thinkingStartTime: null,
          thinkingText: "",
          hasCommittedAssistantChunkInMessage: false,
        },
      };

    case "message_delta": {
      if (event.delta.type === "thinking_delta") {
        return {
          handled: true,
          requestRender: true,
          effects: [{ kind: "start_status_timers" }],
          state: {
            ...base,
            thinkingText: state.thinkingText + event.delta.delta,
            thinkingStartTime: state.thinkingStartTime ?? deps.nowMs,
            overlayStatus: setOverlayStatus(state.overlayStatus, "Thinking…", "default", deps.nowMs),
          },
        };
      }

      if (event.delta.type === "content_block_delta") {
        return {
          handled: true,
          requestRender: true,
          effects: [{ kind: "cleanup_status_timers_if_idle" }],
          state: base,
        };
      }

      const items = [...state.items];
      let thinkingText = state.thinkingText;
      let thinkingStartTime = state.thinkingStartTime;
      let overlayStatus = state.overlayStatus;

      if (thinkingText.length > 0) {
        const elapsedMs = thinkingStartTime !== null ? deps.nowMs - thinkingStartTime : undefined;
        items.push(deps.buildThinkingItem(thinkingText, elapsedMs));
        thinkingText = "";
        thinkingStartTime = null;
        overlayStatus = null;
      }

      return {
        handled: true,
        requestRender: true,
        effects: [{ kind: "markdown_push", delta: event.delta.delta }, { kind: "cleanup_status_timers_if_idle" }],
        state: {
          ...base,
          items,
          thinkingText,
          thinkingStartTime,
          overlayStatus,
        },
      };
    }

    case "message_end": {
      const items = [...state.items];
      let hasCommittedAssistantChunkInMessage = state.hasCommittedAssistantChunkInMessage;
      if (state.thinkingText.length > 0) {
        const elapsedMs = state.thinkingStartTime !== null ? deps.nowMs - state.thinkingStartTime : undefined;
        items.push(deps.buildThinkingItem(state.thinkingText, elapsedMs));
      }
      const committedMarkdownText = deps.getCommittedMarkdownText();
      if (committedMarkdownText) {
        items.push(deps.buildAssistantChunkItem(committedMarkdownText, hasCommittedAssistantChunkInMessage));
        hasCommittedAssistantChunkInMessage = true;
      }
      return {
        handled: true,
        requestRender: true,
        effects: [{ kind: "markdown_finalize" }, { kind: "cleanup_status_timers_if_idle" }],
        state: {
          ...base,
          items,
          thinkingText: "",
          thinkingStartTime: null,
          overlayStatus: null,
          hasCommittedAssistantChunkInMessage: false,
        },
      };
    }

    case "tool_start": {
      const { overlayMessage, collabState } = deps.deriveToolStartState(event, {
        planCallCount: state.planCallCount,
        collabAgentNamesByThreadId: state.collabAgentNamesByThreadId,
      });
      return {
        handled: true,
        requestRender: true,
        effects: [{ kind: "start_status_timers" }],
        state: {
          ...base,
          overlayStatus: setOverlayStatus(state.overlayStatus, overlayMessage, "tool", deps.nowMs),
          toolCalls: {
            ...state.toolCalls,
            [event.toolCallId]: {
              startedAt: deps.nowMs,
              input: event.input,
              startRender: event.render,
            },
          },
          collabByToolCallId: collabState
            ? { ...state.collabByToolCallId, [event.toolCallId]: collabState }
            : state.collabByToolCallId,
        },
      };
    }

    case "tool_update":
      return {
        handled: true,
        requestRender: true,
        effects: [{ kind: "start_status_timers" }],
        state: {
          ...base,
          overlayStatus: setOverlayStatus(
            state.overlayStatus,
            deps.deriveToolUpdateMessage(event, state.collabByToolCallId[event.toolCallId]),
            "tool",
            deps.nowMs,
          ),
        },
      };

    case "tool_end": {
      const toolCall = state.toolCalls[event.toolCallId];
      const collabState = state.collabByToolCallId[event.toolCallId];
      const { item, collabAgentNamesByThreadId, planCallCount } = deps.buildToolEndItem({
        event,
        toolCall,
        collabState,
        planCallCount: state.planCallCount,
        collabAgentNamesByThreadId: state.collabAgentNamesByThreadId,
        nowMs: deps.nowMs,
      });
      const toolCalls = { ...state.toolCalls };
      delete toolCalls[event.toolCallId];
      const collabByToolCallId = { ...state.collabByToolCallId };
      delete collabByToolCallId[event.toolCallId];
      return {
        handled: true,
        requestRender: true,
        effects: state.isThreadBusy ? [{ kind: "start_status_timers" }] : [{ kind: "cleanup_status_timers_if_idle" }],
        state: {
          ...base,
          overlayStatus: null,
          items: [...state.items, item],
          toolCalls,
          collabByToolCallId,
          collabAgentNamesByThreadId,
          planCallCount,
        },
      };
    }

    case "turn_start":
    case "user_message":
      return { handled: true, requestRender: false, state: base, effects: [] };

    case "status_change": {
      if (event.status === "busy") {
        return {
          handled: true,
          requestRender: true,
          effects: [{ kind: "start_status_timers" }],
          state: {
            ...base,
            busyStartedAt: state.busyStartedAt ?? deps.nowMs,
          },
        };
      }

      return {
        handled: true,
        requestRender: true,
        effects: [{ kind: "cleanup_status_timers_if_idle" }],
        state: {
          ...base,
          busyStartedAt: null,
          statusBeforeCompaction: null,
        },
      };
    }

    case "usage":
      return {
        handled: true,
        requestRender: false,
        effects: [],
        state: {
          ...base,
          lastUsage: {
            input: event.usage.inputTokens,
            output: event.usage.outputTokens,
            cost: event.cost,
          },
        },
      };

    case "compaction_start":
      return {
        handled: true,
        requestRender: true,
        effects: [{ kind: "start_status_timers" }],
        state: {
          ...base,
          statusBeforeCompaction: state.overlayStatus?.message ?? null,
          overlayStatus: setOverlayStatus(state.overlayStatus, "Compacting…", "default", deps.nowMs),
        },
      };

    case "compaction_end": {
      const restoredStatus = state.statusBeforeCompaction;
      return {
        handled: true,
        requestRender: true,
        effects: [restoredStatus ? { kind: "start_status_timers" } : { kind: "cleanup_status_timers_if_idle" }],
        state: {
          ...base,
          statusBeforeCompaction: null,
          overlayStatus: restoredStatus
            ? setOverlayStatus(state.overlayStatus, restoredStatus, "default", deps.nowMs)
            : null,
          items: [...state.items, deps.buildCompactionItem(event)],
        },
      };
    }

    case "knowledge_saved":
      return {
        handled: true,
        requestRender: true,
        effects: [],
        state: {
          ...base,
          items: [...state.items, deps.buildKnowledgeSavedItem()],
        },
      };

    case "error":
      return {
        handled: true,
        requestRender: true,
        effects: [{ kind: "cleanup_status_timers_if_idle" }],
        state: {
          ...base,
          isThreadBusy: false,
          busyStartedAt: null,
          statusBeforeCompaction: null,
          overlayStatus: null,
          thinkingStartTime: null,
          thinkingText: "",
          toolCalls: {},
          collabByToolCallId: {},
          hasCommittedAssistantChunkInMessage: false,
          items: [...state.items, deps.buildErrorItem(event.error.message)],
        },
      };

    case "turn_end": {
      const shouldClearCompactionStatus =
        !state.statusBeforeCompaction && state.overlayStatus?.message === "Compacting…";
      return {
        handled: true,
        requestRender: true,
        effects: [{ kind: "cleanup_status_timers_if_idle" }],
        state: {
          ...base,
          isThreadBusy: false,
          busyStartedAt: null,
          overlayStatus: shouldClearCompactionStatus ? null : state.overlayStatus,
        },
      };
    }

    default:
      return { handled: false, requestRender: false, state, effects: [] };
  }
}
