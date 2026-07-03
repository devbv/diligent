// @summary React hook for thread CRUD, switching, and per-thread input state

import type { Mode, SessionSummary, ThinkingEffort, ThreadReadResponse } from "@diligent/protocol";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import type { RefObject } from "react";
import { useCallback, useRef, useState } from "react";
import { type AgentContextItem, getAgentContextItemKey, mergeAgentContextItems } from "./agent-native-bridge";
import { replaceDraftUrl, replaceThreadUrl } from "./app-utils";
import type { WebRpcClient } from "./rpc-client";

export const DRAFT_INPUT_KEY = "__draft__";

export function clearDraftThreadInput(threadInputs: Record<string, string>): Record<string, string> {
  if (!(DRAFT_INPUT_KEY in threadInputs)) {
    return threadInputs;
  }
  const next = { ...threadInputs };
  delete next[DRAFT_INPUT_KEY];
  return next;
}

export function clearDraftThreadContextItems(
  threadContextItems: Record<string, AgentContextItem[]>,
): Record<string, AgentContextItem[]> {
  if (!(DRAFT_INPUT_KEY in threadContextItems)) {
    return threadContextItems;
  }
  const next = { ...threadContextItems };
  delete next[DRAFT_INPUT_KEY];
  return next;
}

export function mergeThreadContextItems(
  threadContextItems: Record<string, AgentContextItem[]>,
  threadKey: string,
  items: AgentContextItem[],
): Record<string, AgentContextItem[]> {
  // An empty incoming list is an explicit clear signal (host/composer reset).
  if (items.length === 0) {
    if (!(threadKey in threadContextItems)) {
      return threadContextItems;
    }
    const next = { ...threadContextItems };
    delete next[threadKey];
    return next;
  }
  // Accumulate incoming selections onto whatever is already attached, deduping by
  // context-item key (e.g. instance GUID) so re-selecting an existing item is a no-op.
  return {
    ...threadContextItems,
    [threadKey]: mergeAgentContextItems(threadContextItems[threadKey] ?? [], items),
  };
}

type ThreadHydrateAction = {
  type: "hydrate";
  payload: { threadId: string; mode: Mode; history: ThreadReadResponse };
};
type ThreadResetDraftAction = { type: "reset_draft"; payload: { mode: Mode } };
type ThreadSetAction = { type: "set_threads"; payload: SessionSummary[] };
type ThreadDispatch = (action: ThreadHydrateAction | ThreadResetDraftAction | ThreadSetAction) => void;

type ActiveThreadSubscription = {
  threadId: string;
  subscriptionId: string;
};

export async function switchThreadSubscription({
  rpc,
  activeSubscription,
  threadId,
  activateThreadPrompts,
}: {
  rpc: WebRpcClient;
  activeSubscription: ActiveThreadSubscription | null;
  threadId: string;
  activateThreadPrompts: (threadId: string) => void;
}): Promise<ActiveThreadSubscription> {
  if (activeSubscription?.threadId === threadId) {
    activateThreadPrompts(threadId);
    return activeSubscription;
  }

  if (activeSubscription) {
    try {
      await rpc.unsubscribe(activeSubscription.subscriptionId);
    } catch (error) {
      console.error(error);
    }
  }

  const subscribed = await rpc.subscribe(threadId);
  activateThreadPrompts(threadId);
  return { threadId, subscriptionId: subscribed.subscriptionId };
}

export function useThreadManager({
  rpcRef,
  dispatch,
  activeThreadIdRef,
  applySessionModel,
  resetDraftModel,
  setEffortState,
  activateThreadPrompts,
  clearAttention,
  closeModals,
}: {
  rpcRef: RefObject<WebRpcClient | null>;
  dispatch: ThreadDispatch;
  activeThreadIdRef: RefObject<string | null>;
  applySessionModel: (sessionModel?: string) => Promise<void>;
  resetDraftModel: () => void;
  setEffortState: (effort: ThinkingEffort) => void;
  activateThreadPrompts: (threadId: string) => void;
  clearAttention: (threadId: string) => void;
  closeModals: () => void;
}) {
  const [pendingDeleteThreadId, setPendingDeleteThreadId] = useState<string | null>(null);
  const [threadInputs, setThreadInputs] = useState<Record<string, string>>({});
  const [threadContextItems, setThreadContextItems] = useState<Record<string, AgentContextItem[]>>({});
  const activeSubscriptionRef = useRef<ActiveThreadSubscription | null>(null);

  const updateThreadContextItems = useCallback((threadKey: string, items: AgentContextItem[]): void => {
    setThreadContextItems((prev) => mergeThreadContextItems(prev, threadKey, items));
  }, []);

  const removeThreadContextItem = useCallback((threadKey: string, itemKey: string): void => {
    setThreadContextItems((prev) => {
      const current = prev[threadKey] ?? [];
      const nextItems = current.filter((item) => getAgentContextItemKey(item) !== itemKey);
      if (nextItems.length === current.length) {
        return prev;
      }
      if (nextItems.length === 0) {
        const next = { ...prev };
        delete next[threadKey];
        return next;
      }
      return { ...prev, [threadKey]: nextItems };
    });
  }, []);

  const clearThreadContextItems = useCallback((threadKey: string): void => {
    setThreadContextItems((prev) => {
      if (!(threadKey in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[threadKey];
      return next;
    });
  }, []);

  const deactivateServerThread = useCallback(async (): Promise<void> => {
    const rpc = rpcRef.current;
    const activeSubscription = activeSubscriptionRef.current;
    activeSubscriptionRef.current = null;
    if (!rpc || !activeSubscription) return;
    try {
      await rpc.unsubscribe(activeSubscription.subscriptionId);
    } catch (error) {
      console.error(error);
    }
  }, [rpcRef]);

  const activateServerThread = useCallback(
    async (threadId: string): Promise<ThreadReadResponse> => {
      const rpc = rpcRef.current;
      if (!rpc) {
        throw new Error("WebSocket is not connected");
      }

      activeSubscriptionRef.current = await switchThreadSubscription({
        rpc,
        activeSubscription: activeSubscriptionRef.current,
        threadId,
        activateThreadPrompts,
      });

      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_READ, { threadId });
    },
    [rpcRef, activateThreadPrompts],
  );

  const refreshThreadList = useCallback(
    async (rpc = rpcRef.current): Promise<void> => {
      if (!rpc) return;
      try {
        const list = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_LIST, { limit: 100 });
        dispatch({ type: "set_threads", payload: list.data });
      } catch (error) {
        console.error(error);
      }
    },
    [rpcRef, dispatch],
  );

  const startNewThread = useCallback(async (): Promise<void> => {
    closeModals();
    await deactivateServerThread();
    dispatch({ type: "reset_draft", payload: { mode: "default" } });
    resetDraftModel();
    if (typeof window !== "undefined") {
      replaceDraftUrl();
    }
  }, [deactivateServerThread, dispatch, resetDraftModel, closeModals]);

  const openThread = useCallback(
    async (threadId: string): Promise<void> => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      closeModals();
      try {
        const resumed = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_RESUME, { threadId });
        if (!resumed.found || !resumed.threadId) return;
        const resumedId = resumed.threadId;
        const history = await activateServerThread(resumedId);

        dispatch({ type: "hydrate", payload: { threadId: resumedId, mode: "default", history } });
        setEffortState(history.currentEffort);
        if (typeof window !== "undefined") {
          replaceThreadUrl(resumedId);
        }
        await refreshThreadList(rpc);
        await applySessionModel(history.currentModel);
        clearAttention(resumedId);
      } catch (error) {
        console.error(error);
      }
    },
    [
      rpcRef,
      dispatch,
      setEffortState,
      refreshThreadList,
      applySessionModel,
      clearAttention,
      activateServerThread,
      closeModals,
    ],
  );

  const confirmDeleteThread = useCallback(async (): Promise<void> => {
    const threadId = pendingDeleteThreadId;
    setPendingDeleteThreadId(null);
    if (!threadId) return;
    const rpc = rpcRef.current;
    if (!rpc) return;
    const activeThreadId = activeThreadIdRef.current;
    try {
      await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_DELETE, { threadId });
      if (activeThreadId === threadId) {
        const resumed = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_RESUME, { mostRecent: true });
        if (resumed.found && resumed.threadId) {
          const history = await activateServerThread(resumed.threadId);
          dispatch({ type: "hydrate", payload: { threadId: resumed.threadId, mode: "default", history } });
          setEffortState(history.currentEffort);
          if (typeof window !== "undefined") {
            replaceThreadUrl(resumed.threadId);
          }
        } else {
          await deactivateServerThread();
          dispatch({ type: "reset_draft", payload: { mode: "default" } });
          resetDraftModel();
          if (typeof window !== "undefined") {
            replaceDraftUrl();
          }
        }
      }
      await refreshThreadList(rpc);
    } catch (error) {
      console.error(error);
    }
  }, [
    pendingDeleteThreadId,
    rpcRef,
    activeThreadIdRef,
    dispatch,
    resetDraftModel,
    setEffortState,
    refreshThreadList,
    activateServerThread,
    deactivateServerThread,
  ]);

  return {
    pendingDeleteThreadId,
    setPendingDeleteThreadId,
    threadInputs,
    setThreadInputs,
    threadContextItems,
    setThreadContextItems,
    updateThreadContextItems,
    removeThreadContextItem,
    clearThreadContextItems,
    refreshThreadList,
    startNewThread,
    openThread,
    confirmDeleteThread,
    activateServerThread,
    deactivateServerThread,
  };
}
