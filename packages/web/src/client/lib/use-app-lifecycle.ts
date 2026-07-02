// @summary App lifecycle hooks for RPC notification wiring and bootstrap resume flow

import type {
  ConsentState,
  DiligentServerNotification,
  DiligentServerRequest,
  InitializeResponse,
  Mode,
  ProviderAuthStatus,
  SkillInfo,
  ThinkingEffort,
} from "@diligent/protocol";
import {
  DILIGENT_CLIENT_NOTIFICATION_METHODS,
  DILIGENT_CLIENT_REQUEST_METHODS,
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  DILIGENT_VERSION,
} from "@diligent/protocol";
import { type Dispatch, type MutableRefObject, type RefObject, type SetStateAction, useEffect } from "react";
import {
  deriveAgentEvents,
  filterSteeringInjectedEvents,
  hasInFlightRenderItems,
  shouldMarkAttentionThread,
  shouldRehydrateAfterIdleStatus,
  toNotificationParams,
} from "./app-notification";
import type { AppAction } from "./app-state";
import { getThreadIdFromUrl, replaceDraftUrl, replaceThreadUrl } from "./app-utils";
import type { WebRpcClient } from "./rpc-client";
import type { ThreadState } from "./thread-store";

function hasNotificationThreadId(params: unknown): params is { threadId: string } {
  return typeof (params as { threadId?: unknown } | null)?.threadId === "string";
}

export function shouldDispatchNotificationToActiveThread(
  notification: DiligentServerNotification,
  activeThreadId: string | null,
): boolean {
  if (!hasNotificationThreadId(notification.params)) {
    return true;
  }
  // Identity notifications can arrive before thread/read hydration. Dispatch
  // them only for the current thread so hydrate actions remain the single path
  // that swaps MessageList history during thread changes.
  if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STARTED) {
    return notification.params.threadId === activeThreadId;
  }
  if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_RESUMED) {
    return notification.params.threadId === activeThreadId;
  }
  if (activeThreadId === null) {
    return false;
  }
  return notification.params.threadId === activeThreadId;
}

type SteeringRefs = {
  pendingAbortRestartMessageRef: MutableRefObject<string | null>;
  suppressNextSteeringInjectedRef: MutableRefObject<boolean>;
  restartFromPendingAbortSteer: (threadId: string) => Promise<void>;
};

export function useAppRpcBindings({
  rpcRef,
  activeThreadIdRef,
  stateRef,
  dispatch,
  refreshThreadList,
  onAccountLoginCompleted,
  onAccountUpdated,
  onMcpLoginCompleted,
  markAttention,
  onBackgroundNotification,
  handleServerRequest,
  steering,
  setOauthPending,
  setOauthError,
}: {
  rpcRef: RefObject<WebRpcClient | null>;
  activeThreadIdRef: RefObject<string | null>;
  stateRef: RefObject<ThreadState>;
  dispatch: Dispatch<AppAction>;
  refreshThreadList: (rpc?: WebRpcClient | null) => Promise<void>;
  onAccountLoginCompleted: (params: { loginId: string | null; success: boolean; error: string | null }) => void;
  onAccountUpdated: (params: { providers: ProviderAuthStatus[] }) => Promise<void>;
  onMcpLoginCompleted: (params: { server: string; success: boolean; error: string | null }) => void;
  markAttention: (threadId: string) => void;
  onBackgroundNotification: (notification: DiligentServerNotification) => void;
  handleServerRequest: (requestId: number, request: DiligentServerRequest) => void;
  steering: SteeringRefs;
  setOauthPending: Dispatch<SetStateAction<boolean>>;
  setOauthError: Dispatch<SetStateAction<string | null>>;
}) {
  useEffect(() => {
    const rpc = rpcRef.current;
    if (!rpc) return;

    rpc.onNotification((notification) => {
      const notificationParams = toNotificationParams(notification);

      if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ACCOUNT_LOGIN_COMPLETED) {
        const params = notification.params;
        if (params.success) {
          setOauthPending(false);
          setOauthError(null);
        } else {
          setOauthPending(false);
          setOauthError(params.error ?? "OAuth flow failed");
        }
        onAccountLoginCompleted(params);
        return;
      }

      if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ACCOUNT_UPDATED) {
        void onAccountUpdated(notification.params);
        return;
      }

      if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.MCP_LOGIN_COMPLETED) {
        onMcpLoginCompleted({
          server: notification.params.server,
          success: notification.params.success,
          error: notification.params.error ?? null,
        });
        return;
      }

      const attentionThreadId = shouldMarkAttentionThread(notification, notificationParams, activeThreadIdRef.current);
      if (attentionThreadId) {
        markAttention(attentionThreadId);
      }

      if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED) {
        onBackgroundNotification(notification);
      }

      if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.THREAD_STATUS_CHANGED) {
        if (!notificationParams) {
          return;
        }
        void refreshThreadList(rpc);

        const rehydrateThreadId = shouldRehydrateAfterIdleStatus(
          notification,
          notificationParams,
          hasInFlightRenderItems(stateRef.current.items),
          activeThreadIdRef.current,
        );
        if (rehydrateThreadId) {
          void rpc
            .request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_READ, { threadId: rehydrateThreadId })
            .then((history) => {
              dispatch({
                type: "hydrate",
                payload: { threadId: rehydrateThreadId, mode: stateRef.current.mode, history },
              });
            })
            .catch(console.error);
        }
      }

      const events = deriveAgentEvents(notification);
      const filtered = filterSteeringInjectedEvents(events, steering.suppressNextSteeringInjectedRef.current);
      if (filtered.consumedSuppression) {
        steering.suppressNextSteeringInjectedRef.current = false;
      }
      if (shouldDispatchNotificationToActiveThread(notification, activeThreadIdRef.current)) {
        dispatch({ type: "notification", payload: { notification, events: filtered.events } });
      }

      if (
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_INTERRUPTED &&
        notificationParams &&
        typeof notificationParams.threadId === "string" &&
        notificationParams.threadId === activeThreadIdRef.current &&
        steering.pendingAbortRestartMessageRef.current
      ) {
        const interruptedThreadId = notificationParams.threadId;
        queueMicrotask(() => {
          void steering.restartFromPendingAbortSteer(interruptedThreadId);
        });
      }
    });

    rpc.onServerRequest((requestId, request) => handleServerRequest(requestId, request));
  }, [
    rpcRef,
    activeThreadIdRef,
    stateRef,
    dispatch,
    refreshThreadList,
    onAccountLoginCompleted,
    onAccountUpdated,
    onMcpLoginCompleted,
    markAttention,
    onBackgroundNotification,
    handleServerRequest,
    steering,
    setOauthPending,
    setOauthError,
  ]);
}

export function useAppBootstrap({
  connection,
  rpcRef,
  activeThreadIdRef,
  dispatch,
  setCwd,
  setEffortState,
  setSkills,
  setRuntimeVersion,
  setConsent,
  setAutoProgressMode,
  setInitialModel,
  applySessionModel,
  refreshThreadList,
  refreshProviders,
}: {
  connection: "connecting" | "connected" | "reconnecting" | "disconnected";
  rpcRef: RefObject<WebRpcClient | null>;
  activeThreadIdRef: RefObject<string | null>;
  dispatch: Dispatch<AppAction>;
  setCwd: Dispatch<SetStateAction<string>>;
  setEffortState: Dispatch<SetStateAction<ThinkingEffort>>;
  setSkills: Dispatch<SetStateAction<SkillInfo[]>>;
  setRuntimeVersion: Dispatch<SetStateAction<string>>;
  setConsent: (consent: ConsentState | null) => void;
  setAutoProgressMode: Dispatch<SetStateAction<boolean>>;
  setInitialModel: (modelId: string, models?: InitializeResponse["availableModels"]) => void;
  applySessionModel: (sessionModel?: string) => Promise<void>;
  refreshThreadList: (rpc?: WebRpcClient | null) => Promise<void>;
  refreshProviders: (rpc?: WebRpcClient | null) => Promise<void>;
}) {
  useEffect(() => {
    if (connection !== "connected") {
      return;
    }

    const rpc = rpcRef.current;
    if (!rpc) return;

    let cancelled = false;

    const hydrateThread = async (threadId: string, mode: Mode): Promise<boolean> => {
      const resumed = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_RESUME, { threadId });
      if (cancelled || !resumed.found || !resumed.threadId) {
        return false;
      }
      const history = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_READ, { threadId: resumed.threadId });
      if (cancelled) return false;
      dispatch({ type: "hydrate", payload: { threadId: resumed.threadId, mode, history } });
      setEffortState(history.currentEffort);
      replaceThreadUrl(resumed.threadId);
      await applySessionModel(history.currentModel);
      await refreshThreadList(rpc);
      return true;
    };

    const bootstrap = async (): Promise<void> => {
      try {
        const meta = (await rpc.initialize({
          clientName: "diligent-web",
          clientVersion: DILIGENT_VERSION,
          protocolVersion: 1,
        })) as InitializeResponse;
        if (cancelled) return;

        setCwd(meta.cwd ?? "");
        setEffortState(meta.effort ?? "medium");
        setSkills(meta.skills ?? []);
        setRuntimeVersion(meta.serverVersion ?? "");
        setConsent(meta.consent ?? null);
        setAutoProgressMode(meta.autoProgressMode ?? false);
        setInitialModel(meta.currentModel ?? "", meta.availableModels ?? []);
        rpc.notify(DILIGENT_CLIENT_NOTIFICATION_METHODS.INITIALIZED, { ready: true });

        const mode = meta.mode ?? "default";
        const previousThreadId = activeThreadIdRef.current;
        if (previousThreadId && (await hydrateThread(previousThreadId, mode))) {
          return;
        }

        const urlThreadId = getThreadIdFromUrl();
        if (urlThreadId && (await hydrateThread(urlThreadId, mode))) {
          return;
        }

        const mostRecent = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_RESUME, { mostRecent: true });
        if (!cancelled && mostRecent.found && mostRecent.threadId && (await hydrateThread(mostRecent.threadId, mode))) {
          return;
        }

        dispatch({ type: "reset_draft", payload: { mode } });
        setEffortState(meta.effort ?? "medium");
        replaceDraftUrl();
        await refreshThreadList(rpc);
      } catch (error) {
        console.error(error);
      } finally {
        await refreshProviders(rpc);
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [
    connection,
    rpcRef,
    activeThreadIdRef,
    dispatch,
    setCwd,
    setEffortState,
    setSkills,
    setRuntimeVersion,
    setConsent,
    setAutoProgressMode,
    setInitialModel,
    applySessionModel,
    refreshThreadList,
    refreshProviders,
  ]);
}
