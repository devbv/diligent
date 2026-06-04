// @summary Consolidated app state hook: thread reducer, UI state, sub-hooks, and derived callbacks
import type {
  KnowledgeEntry,
  KnowledgeUpdateParams,
  SkillInfo,
  ThinkingEffort,
  ThreadReadResponse,
  ToolsListResponse,
  ToolsSetParams,
  ToolsSetResponse,
} from "@diligent/protocol";
import { DILIGENT_CLIENT_REQUEST_METHODS, DILIGENT_SERVER_REQUEST_METHODS } from "@diligent/protocol";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AgentContextItem } from "./agent-native-bridge";
import { APP_PROJECT_NAME } from "./app-config";
import { appReducer, type PendingImage } from "./app-state";
import { getThreadIdFromUrl } from "./app-utils";
import { createDesktopNotificationController, readDesktopNotificationsEnabled } from "./desktop-notification";
import { supportsThinkingNone } from "./model-thinking-helpers";
import { buildCommandList } from "./slash-commands";
import { initialThreadState } from "./thread-store";
import { useAppActions } from "./use-app-actions";
import { useAppBootstrap, useAppRpcBindings } from "./use-app-lifecycle";
import type { useProviderManager } from "./use-provider-manager";
import type { useRpcClient } from "./use-rpc";
import { useServerRequests } from "./use-server-requests";
import { useSteeringQueue } from "./use-steering-queue";
import { clearDraftThreadInput, DRAFT_INPUT_KEY, useThreadManager } from "./use-thread-manager";

type RpcClientResult = ReturnType<typeof useRpcClient>;
type ProviderMgrResult = ReturnType<typeof useProviderManager>;

export function useAppState({
  rpcRef,
  providerMgr,
  connection,
  reconnectAttempts,
}: {
  rpcRef: RpcClientResult["rpcRef"];
  providerMgr: ProviderMgrResult;
  connection: RpcClientResult["connection"];
  reconnectAttempts: RpcClientResult["reconnectAttempts"];
}) {
  void reconnectAttempts;
  useEffect(() => {
    document.title = APP_PROJECT_NAME;
  }, []);

  const activeThreadIdRef = useRef<string | null>(null);
  const [state, dispatch] = useReducer(appReducer, initialThreadState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const [cwd, setCwd] = useState<string>("");
  const cwdRef = useRef<string>("");
  cwdRef.current = cwd;
  const modeRef = useRef(state.mode);
  modeRef.current = state.mode;

  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isUploadingImages, setIsUploadingImages] = useState(false);
  const [effort, setEffortState] = useState<ThinkingEffort>("medium");
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [showToolModal, setShowToolModal] = useState(false);
  const [showKnowledgeModal, setShowKnowledgeModal] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [focusedProvider, setFocusedProvider] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [attentionThreadIds, setAttentionThreadIds] = useState<Set<string>>(new Set());
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [runtimeVersion, setRuntimeVersion] = useState<string>("");
  const childThreadCacheRef = useRef<Map<string, ThreadReadResponse>>(new Map());
  const desktopNotificationsRef = useRef(createDesktopNotificationController());
  const [desktopNotificationsEnabled, setDesktopNotificationsEnabled] = useState(() =>
    readDesktopNotificationsEnabled(),
  );

  const slashCommands = useMemo(() => buildCommandList(skills), [skills]);

  const markAttention = useCallback((threadId: string) => {
    setAttentionThreadIds((prev) => {
      if (prev.has(threadId)) return prev;
      const next = new Set(prev);
      next.add(threadId);
      return next;
    });
  }, []);

  const clearAttention = useCallback((threadId: string) => {
    setAttentionThreadIds((prev) => {
      if (!prev.has(threadId)) return prev;
      const next = new Set(prev);
      next.delete(threadId);
      return next;
    });
  }, []);

  const closeModals = useCallback(() => {
    setShowKnowledgeModal(false);
    setShowToolModal(false);
  }, []);

  const serverRequests = useServerRequests(
    rpcRef,
    activeThreadIdRef,
    markAttention,
    (requestId, request) => void desktopNotificationsRef.current.notifyForServerRequest(requestId, request),
  );

  activeThreadIdRef.current = state.activeThreadId;

  const threadMgr = useThreadManager({
    rpcRef,
    dispatch,
    activeThreadIdRef,
    modeRef,
    applySessionModel: providerMgr.applySessionModel,
    resetDraftModel: providerMgr.resetDraftModel,
    setEffortState,
    activateThreadPrompts: serverRequests.activateThread,
    clearAttention,
    closeModals,
  });

  const loadChildThread = useCallback(
    async (childThreadId: string): Promise<ThreadReadResponse> => {
      const cached = childThreadCacheRef.current.get(childThreadId);
      if (cached) return cached;
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("WebSocket is not connected");
      const response = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_READ, { threadId: childThreadId });
      childThreadCacheRef.current.set(childThreadId, response);
      return response;
    },
    [rpcRef],
  );

  useEffect(() => {
    desktopNotificationsRef.current.setEnabled(desktopNotificationsEnabled);
  }, [desktopNotificationsEnabled]);

  useEffect(() => {
    void desktopNotificationsRef.current.attachActionHandler((threadId) => {
      void threadMgr.openThread(threadId);
    });
  }, [threadMgr.openThread]);

  useEffect(() => {
    const handlePopState = () => {
      const urlThreadId = getThreadIdFromUrl();
      if (urlThreadId && urlThreadId !== activeThreadIdRef.current) {
        void threadMgr.openThread(urlThreadId);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [threadMgr.openThread]);

  useEffect(() => {
    if (!state.toast) return;
    if (state.toast.kind === "error") {
      console.error("[diligent]", state.toast.message);
    }
    if (state.toast.fatal) return;
    const id = setTimeout(() => dispatch({ type: "clear_toast" }), 4000);
    return () => clearTimeout(id);
  }, [state.toast]);

  const isBusy = state.threadStatus === "busy";
  const activeInputKey = state.activeThreadId ?? DRAFT_INPUT_KEY;
  const activeInput = threadMgr.threadInputs[activeInputKey] ?? "";
  const activeContextItems = threadMgr.threadContextItems[activeInputKey] ?? [];

  const setActiveInput = useCallback(
    (value: string) => {
      const inputKey = state.activeThreadId ?? DRAFT_INPUT_KEY;
      threadMgr.setThreadInputs((prev) => {
        const next = value.length > 0 ? { ...prev, [inputKey]: value } : { ...prev };
        if (value.length === 0) delete next[inputKey];
        return next;
      });
    },
    [state.activeThreadId, threadMgr.setThreadInputs],
  );

  const clearThreadInput = useCallback(
    (threadId: string) => {
      threadMgr.setThreadInputs((prev) => {
        if (!(threadId in prev)) return prev;
        const next = { ...prev };
        delete next[threadId];
        return next;
      });
    },
    [threadMgr.setThreadInputs],
  );

  const clearDraftInput = useCallback(() => {
    threadMgr.setThreadInputs((prev) => clearDraftThreadInput(prev));
  }, [threadMgr.setThreadInputs]);

  const updateActiveContextItems = useCallback(
    (items: AgentContextItem[]) => {
      const inputKey = state.activeThreadId ?? DRAFT_INPUT_KEY;
      threadMgr.updateThreadContextItems(inputKey, items);
    },
    [state.activeThreadId, threadMgr.updateThreadContextItems],
  );

  const removeActiveContextItem = useCallback(
    (itemKey: string) => {
      const inputKey = state.activeThreadId ?? DRAFT_INPUT_KEY;
      threadMgr.removeThreadContextItem(inputKey, itemKey);
    },
    [state.activeThreadId, threadMgr.removeThreadContextItem],
  );

  const clearActiveContextItems = useCallback(() => {
    const inputKey = state.activeThreadId ?? DRAFT_INPUT_KEY;
    threadMgr.clearThreadContextItems(inputKey);
  }, [state.activeThreadId, threadMgr.clearThreadContextItems]);

  const clearPendingImages = useCallback(() => {
    setPendingImages([]);
  }, []);

  const canSend =
    (activeInput.trim().length > 0 || pendingImages.length > 0 || activeContextItems.length > 0) &&
    !isBusy &&
    !isUploadingImages;

  const steeringQueue = useSteeringQueue({
    rpcRef,
    stateRef,
    dispatch,
    activeThreadId: state.activeThreadId,
    currentModelRef: providerMgr.currentModelRef,
    activeInput,
    pendingImages,
    isBusy,
    clearThreadInput,
    clearPendingImages,
  });

  useAppRpcBindings({
    rpcRef,
    activeThreadIdRef,
    stateRef,
    dispatch,
    refreshThreadList: threadMgr.refreshThreadList,
    onAccountLoginCompleted: providerMgr.onAccountLoginCompleted,
    onAccountUpdated: providerMgr.onAccountUpdated,
    markAttention,
    onBackgroundNotification: (notification) =>
      void desktopNotificationsRef.current.notifyForNotification(notification),
    handleServerRequest: serverRequests.handleServerRequest,
    steering: {
      pendingAbortRestartMessageRef: steeringQueue.pendingAbortRestartMessageRef,
      suppressNextSteeringInjectedRef: steeringQueue.suppressNextSteeringInjectedRef,
      restartFromPendingAbortSteer: steeringQueue.restartFromPendingAbortSteer,
    },
    setOauthPending,
    setOauthError,
  });

  useAppBootstrap({
    connection,
    rpcRef,
    activeThreadIdRef,
    dispatch,
    setCwd,
    setEffortState,
    setSkills,
    setRuntimeVersion,
    setInitialModel: providerMgr.setInitialModel,
    applySessionModel: providerMgr.applySessionModel,
    refreshThreadList: threadMgr.refreshThreadList,
    refreshProviders: providerMgr.refreshProviders,
  });

  const currentModelInfo = providerMgr.availableModels.find((m) => m.id === providerMgr.currentModel);
  const supportsVision = currentModelInfo?.supportsVision === true;
  const supportsThinking = currentModelInfo?.supportsThinking === true;

  const actions = useAppActions({
    rpcRef,
    state,
    stateRef,
    dispatch,
    activeInput,
    activeContextItems,
    pendingImages,
    canSend,
    isUploadingImages,
    supportsVision,
    effort,
    slashCommands,
    currentModel: providerMgr.currentModel,
    availableModels: providerMgr.availableModels,
    currentModelRef: providerMgr.currentModelRef,
    clearThreadInput,
    clearDraftInput,
    clearActiveContextItems,
    setPendingImages,
    setIsUploadingImages,
    setEffortState,
    changeModel: providerMgr.changeModel,
    startNewThread: threadMgr.startNewThread,
    openThread: threadMgr.openThread,
    steeringControl: {
      pendingAbortRestartMessageRef: steeringQueue.pendingAbortRestartMessageRef,
      suppressNextSteeringInjectedRef: steeringQueue.suppressNextSteeringInjectedRef,
    },
    modeRef,
    cwdRef,
    applySessionModel: providerMgr.applySessionModel,
    activateServerThread: threadMgr.activateServerThread,
    refreshThreadList: threadMgr.refreshThreadList,
  });

  useEffect(() => {
    if (effort !== "none") return;
    if (!currentModelInfo) return;
    if (supportsThinkingNone(currentModelInfo)) return;
    setEffortState("medium");
  }, [effort, currentModelInfo]);

  const listTools = useCallback(async (): Promise<ToolsListResponse> => {
    const rpc = rpcRef.current;
    if (!rpc) throw new Error("WebSocket is not connected");
    return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_LIST, {
      threadId: state.activeThreadId ?? undefined,
    });
  }, [rpcRef, state.activeThreadId]);

  const saveTools = useCallback(
    async (params: ToolsSetParams): Promise<ToolsSetResponse> => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("WebSocket is not connected");
      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_SET, params);
    },
    [rpcRef],
  );

  const listKnowledge = useCallback(
    async (threadId?: string): Promise<{ data: KnowledgeEntry[] }> => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("WebSocket is not connected");
      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_LIST, { threadId, limit: 500 });
    },
    [rpcRef],
  );

  const updateKnowledge = useCallback(
    async (params: KnowledgeUpdateParams): Promise<{ entry?: KnowledgeEntry; deleted?: boolean }> => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("WebSocket is not connected");
      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_UPDATE, params);
    },
    [rpcRef],
  );

  const threadTitle = useMemo(() => {
    const active = state.threadList.find((t) => t.id === state.activeThreadId);
    const raw = active?.firstUserMessage ?? state.items.find((i) => i.kind === "user")?.text ?? "";
    return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
  }, [state.activeThreadId, state.threadList, state.items]);

  const pendingImagePreviews = useMemo(
    () => pendingImages.map((image) => ({ path: image.path, url: image.webUrl, fileName: image.fileName })),
    [pendingImages],
  );

  const handleQuestionAnswerChange = useCallback(
    (id: string, val: string | string[]) => serverRequests.setAnswers((prev) => ({ ...prev, [id]: val })),
    [serverRequests.setAnswers],
  );
  const handleQuestionSubmit = useCallback(
    () => serverRequests.resolveQuestion(serverRequests.answers),
    [serverRequests],
  );
  const handleQuestionCancel = useCallback(() => serverRequests.resolveQuestion({}), [serverRequests]);
  const handleOpenProviders = useCallback(() => {
    setFocusedProvider(null);
    setShowProviderModal(true);
  }, []);
  const handleQuickConnectChatGPT = useCallback(() => {
    setOauthPending(true);
    setOauthError(null);
    void providerMgr.handleOAuthStart("chatgpt").catch((error) => {
      setOauthPending(false);
      setOauthError(error instanceof Error ? error.message : "Failed to start OAuth");
      setFocusedProvider("chatgpt");
      setShowProviderModal(true);
    });
  }, [providerMgr]);
  const approvalPrompt = useMemo(
    () =>
      serverRequests.approvalPrompt?.request.method === DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST
        ? {
            request: serverRequests.approvalPrompt.request.params.request,
            onDecide: serverRequests.resolveApproval,
          }
        : null,
    [serverRequests.approvalPrompt, serverRequests.resolveApproval],
  );
  const questionPrompt = useMemo(
    () =>
      serverRequests.questionPrompt
        ? {
            request: serverRequests.questionPrompt.request,
            answers: serverRequests.answers,
            onAnswerChange: handleQuestionAnswerChange,
            onSubmit: handleQuestionSubmit,
            onCancel: handleQuestionCancel,
          }
        : null,
    [
      serverRequests.questionPrompt,
      serverRequests.answers,
      handleQuestionAnswerChange,
      handleQuestionSubmit,
      handleQuestionCancel,
    ],
  );

  return {
    state,
    dispatch,
    stateRef,
    activeThreadIdRef,
    cwd,
    setCwd,
    cwdRef,
    modeRef,
    pendingImages,
    setPendingImages,
    isUploadingImages,
    setIsUploadingImages,
    effort,
    setEffortState,
    showProviderModal,
    setShowProviderModal,
    showToolModal,
    setShowToolModal,
    showKnowledgeModal,
    setShowKnowledgeModal,
    sidebarOpen,
    setSidebarOpen,
    focusedProvider,
    setFocusedProvider,
    oauthPending,
    setOauthPending,
    oauthError,
    setOauthError,
    attentionThreadIds,
    skills,
    setSkills,
    runtimeVersion,
    setRuntimeVersion,
    desktopNotificationsEnabled,
    setDesktopNotificationsEnabled,
    desktopNotificationsRef,
    childThreadCacheRef,
    slashCommands,
    isBusy,
    activeInputKey,
    activeInput,
    activeContextItems,
    setActiveInput,
    clearThreadInput,
    clearDraftInput,
    updateActiveContextItems,
    removeActiveContextItem,
    clearActiveContextItems,
    clearPendingImages,
    canSend,
    supportsVision,
    supportsThinking,
    currentModelInfo,
    threadTitle,
    pendingImagePreviews,
    threadMgr,
    serverRequests,
    steeringQueue,
    actions,
    listTools,
    saveTools,
    listKnowledge,
    updateKnowledge,
    handleQuestionAnswerChange,
    handleQuestionSubmit,
    handleQuestionCancel,
    handleOpenProviders,
    handleQuickConnectChatGPT,
    approvalPrompt,
    questionPrompt,
    loadChildThread,
    showPlan: state.planState?.steps.some((s) => s.status !== "done") ?? false,
  };
}
