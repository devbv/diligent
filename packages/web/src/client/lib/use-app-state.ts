// @summary Composition hook: assembles consent, notification, modal, and thread state sub-hooks
import type { SkillInfo, ThinkingEffort, ThreadReadResponse } from "@diligent/protocol";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AgentContextItem } from "./agent-native-bridge";
import { APP_PROJECT_NAME } from "./app-config";
import { appReducer, type PendingImage } from "./app-state";
import { getThreadIdFromUrl } from "./app-utils";
import { supportsThinkingNone } from "./model-thinking-helpers";
import { buildCommandList } from "./slash-commands";
import { initialThreadState } from "./thread-store";
import { useAppActions } from "./use-app-actions";
import { useAppBootstrap, useAppRpcBindings } from "./use-app-lifecycle";
import { useConsentState } from "./use-consent-state";
import { useModalState } from "./use-modal-state";
import { useNotificationState } from "./use-notification-state";
import type { useProviderManager } from "./use-provider-manager";
import type { useRpcClient } from "./use-rpc";
import { useServerRequests } from "./use-server-requests";
import { useSteeringQueue } from "./use-steering-queue";
import { useThreadData } from "./use-thread-data";
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
  const [showImageUploadIndicator, setShowImageUploadIndicator] = useState(false);
  const [effort, setEffortState] = useState<ThinkingEffort>("medium");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [runtimeVersion, setRuntimeVersion] = useState<string>("");
  const childThreadCacheRef = useRef<Map<string, ThreadReadResponse>>(new Map());
  const threadData = useThreadData({ rpcRef, state, childThreadCacheRef });

  const consentState = useConsentState({ rpcRef });
  const modalState = useModalState({ providerMgr });
  const notificationState = useNotificationState();

  const slashCommands = useMemo(() => buildCommandList(skills), [skills]);

  const serverRequests = useServerRequests(
    rpcRef,
    activeThreadIdRef,
    notificationState.markAttention,
    (requestId, request) =>
      void notificationState.desktopNotificationsRef.current.notifyForServerRequest(requestId, request),
  );

  activeThreadIdRef.current = state.activeThreadId;

  const threadMgr = useThreadManager({
    rpcRef,
    dispatch,
    activeThreadIdRef,
    applySessionModel: providerMgr.applySessionModel,
    resetDraftModel: providerMgr.resetDraftModel,
    setEffortState,
    activateThreadPrompts: serverRequests.activateThread,
    clearAttention: notificationState.clearAttention,
    closeModals: modalState.closeModals,
  });

  useEffect(() => {
    const { desktopNotificationsRef } = notificationState;
    void desktopNotificationsRef.current.attachActionHandler((threadId) => {
      void threadMgr.openThread(threadId);
    });
  }, [threadMgr.openThread, notificationState]);

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
    contextItems: activeContextItems,
    isBusy,
    clearThreadInput,
    clearPendingImages,
    clearContextItems: clearActiveContextItems,
  });

  useAppRpcBindings({
    rpcRef,
    activeThreadIdRef,
    stateRef,
    dispatch,
    refreshThreadList: threadMgr.refreshThreadList,
    onAccountLoginCompleted: providerMgr.onAccountLoginCompleted,
    onAccountUpdated: providerMgr.onAccountUpdated,
    onMcpLoginCompleted: modalState.bumpMcpRefreshNonce,
    markAttention: notificationState.markAttention,
    onBackgroundNotification: (notification) =>
      void notificationState.desktopNotificationsRef.current.notifyForNotification(notification),
    handleServerRequest: serverRequests.handleServerRequest,
    steering: {
      pendingAbortRestartMessageRef: steeringQueue.pendingAbortRestartMessageRef,
      suppressNextSteeringInjectedRef: steeringQueue.suppressNextSteeringInjectedRef,
      restartFromPendingAbortSteer: steeringQueue.restartFromPendingAbortSteer,
    },
    setOauthPending: modalState.setOauthPending,
    setOauthError: modalState.setOauthError,
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
    setConsent: consentState.setConsent,
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
    setShowImageUploadIndicator,
    setEffortState,
    changeModel: providerMgr.changeModel,
    startNewThread: threadMgr.startNewThread,
    openThread: threadMgr.openThread,
    openMcpModal: modalState.openMcpModal,
    bumpMcpRefreshNonce: modalState.bumpMcpRefreshNonce,
    setSkills,
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

  const pendingImagePreviews = useMemo(
    () =>
      pendingImages.map((image) => ({
        path: image.path,
        url: image.webUrl,
        fileName: image.fileName,
      })),
    [pendingImages],
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
    showImageUploadIndicator,
    setShowImageUploadIndicator,
    effort,
    setEffortState,
    ...modalState,
    attentionThreadIds: notificationState.attentionThreadIds,
    skills,
    setSkills,
    runtimeVersion,
    setRuntimeVersion,
    ...consentState,
    desktopNotificationsEnabled: notificationState.desktopNotificationsEnabled,
    setDesktopNotificationsEnabled: notificationState.setDesktopNotificationsEnabled,
    desktopNotificationsRef: notificationState.desktopNotificationsRef,
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
    threadTitle: threadData.threadTitle,
    pendingImagePreviews,
    threadMgr,
    serverRequests,
    steeringQueue,
    actions,
    listTools: threadData.listTools,
    saveTools: threadData.saveTools,
    listKnowledge: threadData.listKnowledge,
    updateKnowledge: threadData.updateKnowledge,
    listMcpServers: threadData.listMcpServers,
    mcpLoginStart: threadData.mcpLoginStart,
    mcpLogout: threadData.mcpLogout,
    approvalPrompt: serverRequests.approvalPrompt,
    questionPrompt: serverRequests.questionPrompt,
    loadChildThread: threadData.loadChildThread,
  };
}
