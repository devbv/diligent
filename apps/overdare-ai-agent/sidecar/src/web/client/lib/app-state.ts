// @summary App-level thread state reducer and actions extracted from App orchestrator

import type {
  AgentEvent,
  DiligentServerNotification,
  LocalImageBlock,
  Mode,
  PendingSteer,
  SessionSummary,
  ThreadReadResponse,
} from "@diligent/protocol";
import type { AgentContextItem } from "./agent-native-bridge";
import {
  hydrateFromThreadRead,
  initialThreadState,
  type RenderItem,
  reduceServerNotification,
  type ThreadState,
} from "./thread-store";

export type PendingImage = LocalImageBlock & { webUrl: string };

export type AppAction =
  | { type: "notification"; payload: { notification: DiligentServerNotification; events: AgentEvent[] } }
  | { type: "hydrate"; payload: { threadId: string; mode: Mode; history: ThreadReadResponse } }
  | { type: "reset_draft"; payload: { mode: Mode } }
  | { type: "set_threads"; payload: SessionSummary[] }
  | { type: "set_mode"; payload: Mode }
  | {
      type: "local_user";
      payload: { id: string; text: string; images: PendingImage[]; contextItems?: AgentContextItem[] };
    }
  | { type: "bind_user_message_id"; payload: { renderItemId: string; messageId: string } }
  | { type: "local_steer"; payload: PendingSteer }
  | { type: "cancel_pending_steer"; payload: { steerId: string } }
  | { type: "update_pending_steer"; payload: { steerId: string; content: string } }
  | { type: "consume_first_pending_steer" }
  | { type: "optimistic_thread"; payload: { threadId: string; message: string } }
  | { type: "show_info_toast"; payload: string }
  | { type: "clear_toast" }
  | { type: "compaction_error" };

export function appReducer(state: ThreadState, action: AppAction): ThreadState {
  const isDraftOptimisticThread = (thread: SessionSummary): boolean =>
    thread.path.length === 0 && thread.cwd.length === 0 && thread.messageCount <= 1 && Boolean(thread.firstUserMessage);
  const isVisibleThread = (thread: SessionSummary): boolean => {
    if (thread.messageCount > 0) return true;
    if (thread.firstUserMessage) return true;
    return false;
  };

  if (action.type === "notification")
    return reduceServerNotification(state, action.payload.notification, action.payload.events);
  if (action.type === "hydrate") {
    const mode = action.payload.history.currentMode ?? action.payload.mode;
    return hydrateFromThreadRead(
      {
        ...state,
        activeThreadId: action.payload.threadId,
        activeThreadCwd: action.payload.history.cwd,
        mode,
      },
      action.payload.history,
    );
  }
  if (action.type === "reset_draft") {
    return {
      ...initialThreadState,
      mode: action.payload.mode,
      threadList: state.threadList,
      pendingSteers: state.pendingSteers,
    };
  }
  if (action.type === "set_mode") return { ...state, mode: action.payload };
  if (action.type === "set_threads") {
    const optimisticMessages = new Map(
      state.threadList.filter((t) => t.firstUserMessage).map((t) => [t.id, t.firstUserMessage!]),
    );
    const serverThreadIds = new Set(action.payload.map((t) => t.id));
    const merged = action.payload
      .map((t) =>
        !t.firstUserMessage && optimisticMessages.has(t.id)
          ? { ...t, firstUserMessage: optimisticMessages.get(t.id) }
          : t,
      )
      .filter(isVisibleThread);
    const missingOptimistic = state.threadList.filter((t) => isDraftOptimisticThread(t) && !serverThreadIds.has(t.id));
    return { ...state, threadList: [...missingOptimistic, ...merged] };
  }
  if (action.type === "local_user") {
    const text = action.payload.text;
    const userItem: RenderItem = {
      id: action.payload.id,
      kind: "user",
      text,
      contextItems: action.payload.contextItems ?? [],
      images: action.payload.images.map((image) => ({
        url: image.webUrl,
        fileName: image.fileName,
        mediaType: image.mediaType,
      })),
      timestamp: Date.now(),
    };
    return { ...state, items: [...state.items, userItem] };
  }
  if (action.type === "bind_user_message_id") {
    return {
      ...state,
      items: state.items.map((item) =>
        item.kind === "user" && item.id === action.payload.renderItemId
          ? { ...item, messageId: action.payload.messageId }
          : item,
      ),
    };
  }
  if (action.type === "local_steer") {
    return { ...state, pendingSteers: [...state.pendingSteers, action.payload] };
  }
  if (action.type === "cancel_pending_steer") {
    return {
      ...state,
      pendingSteers: state.pendingSteers.filter((steer) => steer.id !== action.payload.steerId),
    };
  }
  if (action.type === "update_pending_steer") {
    return {
      ...state,
      pendingSteers: state.pendingSteers.map((steer) =>
        steer.id === action.payload.steerId ? { ...steer, content: action.payload.content } : steer,
      ),
    };
  }
  if (action.type === "consume_first_pending_steer") {
    return state.pendingSteers.length === 0 ? state : { ...state, pendingSteers: state.pendingSteers.slice(1) };
  }
  if (action.type === "optimistic_thread") {
    const { threadId, message } = action.payload;
    const now = new Date().toISOString();
    const existing = state.threadList.find((t) => t.id === threadId);
    if (existing) {
      if (existing.firstUserMessage) return state;
      return {
        ...state,
        threadList: state.threadList.map((t) =>
          t.id === threadId ? { ...t, firstUserMessage: message, modified: now } : t,
        ),
      };
    }
    const optimistic: SessionSummary = {
      id: threadId,
      path: "",
      cwd: "",
      created: now,
      modified: now,
      messageCount: 1,
      firstUserMessage: message,
    };
    return { ...state, threadList: [optimistic, ...state.threadList] };
  }
  if (action.type === "show_info_toast") {
    return {
      ...state,
      toast: {
        id: `info-${Date.now()}`,
        kind: "info",
        message: action.payload,
      },
    };
  }
  if (action.type === "clear_toast") return { ...state, toast: null };
  if (action.type === "compaction_error") return { ...state, isCompacting: false };
  return state;
}
