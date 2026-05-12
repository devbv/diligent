// @summary Main application component: RPC setup and JSX rendering (state managed by useAppState)

import { useEffect, useMemo } from "react";
import { Button } from "./components/Button";
import { InputDock } from "./components/InputDock";
import { KnowledgeManagerModal } from "./components/KnowledgeManagerModal";
import { MessageList } from "./components/MessageList";
import { Modal } from "./components/Modal";
import { Panel } from "./components/Panel";
import { PlanPanel } from "./components/PlanPanel";
import { ProviderSettingsModal } from "./components/ProviderSettingsModal";
import { Sidebar } from "./components/Sidebar";
import { SteeringQueuePanel } from "./components/SteeringQueuePanel";
import { ToolSettingsModal } from "./components/ToolSettingsModal";
import { createAgentNativeBridge, installAgentNativeBridgeMock } from "./lib/agent-native-bridge";
import { getReconnectAttemptLimit } from "./lib/rpc-client";
import { useAppState } from "./lib/use-app-state";
import { useProviderManager } from "./lib/use-provider-manager";
import { useRpcClient } from "./lib/use-rpc";

export function App() {
  const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/rpc`;
  const { rpcRef, connection, reconnectAttempts, retryConnection } = useRpcClient(wsUrl);
  const providerMgr = useProviderManager(rpcRef);

  const {
    state,
    dispatch,
    cwd,
    sidebarOpen,
    setSidebarOpen,
    showProviderModal,
    setShowProviderModal,
    showToolModal,
    setShowToolModal,
    showKnowledgeModal,
    setShowKnowledgeModal,
    focusedProvider,
    setFocusedProvider,
    oauthPending,
    setOauthPending,
    oauthError,
    setOauthError,
    attentionThreadIds,
    runtimeVersion,
    desktopNotificationsEnabled,
    setDesktopNotificationsEnabled,
    slashCommands,
    activeInput,
    activeContextItems,
    setActiveInput,
    removeActiveContextItem,
    clearActiveContextItems,
    updateActiveContextItems,
    canSend,
    supportsVision,
    supportsThinking,
    threadTitle,
    pendingImagePreviews,
    effort,
    isUploadingImages,
    threadMgr,
    steeringQueue,
    actions,
    listTools,
    saveTools,
    listKnowledge,
    updateKnowledge,
    loadChildThread,
    handleOpenProviders,
    handleQuickConnectChatGPT,
    approvalPrompt,
    questionPrompt,
  } = useAppState({ rpcRef, providerMgr, connection, reconnectAttempts });

  const { startNewThread, openThread, confirmDeleteThread } = threadMgr;
  const { handleSteer, canSteer } = steeringQueue;
  const {
    handleSend,
    handleInterrupt,
    handleModeChange,
    handleEffortChange,
    handleModelChange,
    handleCompactionClick,
    handleAddImagesToDock,
    handleRemovePendingImage,
    handleSlashCommand,
  } = actions;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const previousBridge = window.AgentNativeBridge;
    window.AgentNativeBridge = createAgentNativeBridge({
      updateContextItems: updateActiveContextItems,
    });
    installAgentNativeBridgeMock(window);
    return () => {
      window.AgentNativeBridge = previousBridge;
    };
  }, [updateActiveContextItems]);

  const retryLimit = getReconnectAttemptLimit();
  const showConnectionModal = connection === "reconnecting" || (connection === "disconnected" && reconnectAttempts > 0);
  const contextWindow = useMemo(
    () => providerMgr.availableModels.find((m) => m.id === providerMgr.currentModel)?.contextWindow ?? 0,
    [providerMgr.availableModels, providerMgr.currentModel],
  );
  const hasProvider = useMemo(() => providerMgr.providers.some((p) => p.configured), [providerMgr.providers]);
  const effectiveHasProvider = hasProvider || !providerMgr.providerStatusResolved;
  const showPlan = state.planState?.steps.some((s) => s.status !== "done");

  return (
    <div className="h-screen bg-black text-text">
      <div className="flex h-full bg-black">
        <div
          className="shrink-0 overflow-hidden border-r border-border/100 transition-[width] duration-200"
          style={{ width: sidebarOpen ? 280 : 0 }}
        >
          <Sidebar
            cwd={cwd}
            threadList={state.threadList}
            activeThreadId={state.activeThreadId}
            attentionThreadIds={attentionThreadIds}
            onNewThread={() => void startNewThread()}
            onOpenThread={(id) => void openThread(id)}
            onDeleteThread={(id) => threadMgr.setPendingDeleteThreadId(id)}
          />
        </div>

        <Panel className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-surface-dark !rounded-none !border-0">
          <div className="flex h-16 shrink-0 items-center gap-2 border-b border-border/100 bg-surface-dark px-3">
            <button
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-surface-light hover:text-text"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <rect x="1" y="3.5" width="14" height="1.2" rx="0.6" fill="currentColor" />
                <rect x="1" y="7.4" width="14" height="1.2" rx="0.6" fill="currentColor" />
                <rect x="1" y="11.3" width="14" height="1.2" rx="0.6" fill="currentColor" />
              </svg>
            </button>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-icon-success)]" aria-hidden="true" />
            {(state.threadStatus !== "idle" || state.isCompacting) && (
              <span
                className={`shrink-0 font-mono text-xs ${state.isCompacting || state.threadStatus === "busy" ? "text-text-success" : "text-danger"}`}
              >
                {state.isCompacting
                  ? "Compacting..."
                  : state.threadStatus === "busy"
                    ? "Running..."
                    : state.threadStatus}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-xs uppercase tracking-[0.12em] text-muted/90">
              {threadTitle || "new conversation"}
            </span>
            <button
              type="button"
              onClick={() => {
                setShowToolModal(false);
                setShowKnowledgeModal(true);
              }}
              aria-label="Open knowledge"
              title="Knowledge"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-knowledge-backlog/35 bg-knowledge-backlog/12 text-sm text-knowledge-backlog/90 transition hover:border-knowledge-backlog/55 hover:bg-knowledge-backlog/18 hover:text-knowledge-backlog"
            >
              <span className="block leading-none">✦</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setShowKnowledgeModal(false);
                setShowToolModal(true);
              }}
              aria-label="Open config"
              title="Config"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border/100 bg-surface-light text-sm text-muted transition hover:border-border-strong/100 hover:bg-surface-strong hover:text-text"
            >
              <span className="block leading-none">⚙</span>
            </button>
          </div>

          <MessageList
            items={state.items}
            threadStatus={state.threadStatus}
            threadCwd={state.activeThreadCwd ?? undefined}
            hasProvider={effectiveHasProvider}
            oauthPending={oauthPending}
            onOpenProviders={handleOpenProviders}
            onQuickConnectChatGPT={handleQuickConnectChatGPT}
            isCompacting={state.isCompacting}
            approvalPrompt={approvalPrompt}
            questionPrompt={questionPrompt}
            onLoadChildThread={loadChildThread}
          />

          {showPlan && <PlanPanel planState={state.planState!} />}

          <SteeringQueuePanel pendingSteers={state.pendingSteers} />

          <InputDock
            input={activeInput}
            onInputChange={setActiveInput}
            onSend={handleSend}
            onSteer={handleSteer}
            onInterrupt={handleInterrupt}
            onCompactionClick={handleCompactionClick}
            isCompacting={state.isCompacting}
            canSend={canSend}
            canSteer={canSteer}
            threadStatus={state.threadStatus}
            mode={state.mode}
            onModeChange={handleModeChange}
            effort={effort}
            onEffortChange={handleEffortChange}
            currentModel={providerMgr.currentModel}
            availableModels={providerMgr.availableModels}
            onModelChange={handleModelChange}
            usage={state.usage}
            currentContextTokens={state.currentContextTokens}
            contextWindow={contextWindow}
            hasProvider={hasProvider}
            supportsVision={supportsVision}
            supportsThinking={supportsThinking}
            pendingImages={pendingImagePreviews}
            contextItems={activeContextItems}
            isUploadingImages={isUploadingImages}
            onAddImages={handleAddImagesToDock}
            onRemoveImage={handleRemovePendingImage}
            onRemoveContextItem={removeActiveContextItem}
            onClearContextItems={clearActiveContextItems}
            onSlashCommand={handleSlashCommand}
            slashCommands={slashCommands}
          />

          {showToolModal ? (
            <ToolSettingsModal
              threadId={state.activeThreadId}
              runtimeVersion={runtimeVersion}
              providers={providerMgr.providers}
              desktopNotificationsEnabled={desktopNotificationsEnabled}
              onList={listTools}
              onSave={saveTools}
              onDesktopNotificationsEnabledChange={setDesktopNotificationsEnabled}
              onOpenProviders={() => {
                setFocusedProvider(hasProvider ? null : "chatgpt");
                setShowProviderModal(true);
              }}
              onClose={() => setShowToolModal(false)}
              className="absolute inset-0 z-40 bg-overlay/35"
            />
          ) : null}

          {showKnowledgeModal ? (
            <KnowledgeManagerModal
              threadId={state.activeThreadId}
              onList={listKnowledge}
              onUpdate={updateKnowledge}
              onClose={() => setShowKnowledgeModal(false)}
              className="absolute inset-0 z-40 bg-overlay/35"
            />
          ) : null}
        </Panel>
      </div>

      {state.toast ? (
        <div
          className={`toast-animate fixed bottom-12 left-1/2 -translate-x-1/2 rounded-md border px-3 py-2 text-sm shadow-panel ${
            state.toast.kind === "error"
              ? "border-danger/40 bg-surface-default text-danger"
              : "border-accent/40 bg-surface-default text-accent"
          } ${state.toast.fatal ? "cursor-pointer" : ""}`}
          onClick={state.toast.fatal ? () => dispatch({ type: "clear_toast" }) : undefined}
        >
          {state.toast.message}
          {state.toast.fatal && <span className="ml-2 opacity-50">×</span>}
        </div>
      ) : null}

      {showProviderModal ? (
        <ProviderSettingsModal
          providers={providerMgr.providers}
          focusProvider={focusedProvider ?? undefined}
          oauthPending={oauthPending}
          oauthError={oauthError}
          onSet={providerMgr.handleSetProviderKey}
          onRemove={providerMgr.handleRemoveProviderKey}
          onOAuthStart={async () => {
            setOauthPending(true);
            setOauthError(null);
            const result = await providerMgr.handleOAuthStart("chatgpt");
            return result;
          }}
          onClose={() => {
            setShowProviderModal(false);
            setFocusedProvider(null);
            setOauthError(null);
          }}
        />
      ) : null}

      {threadMgr.pendingDeleteThreadId ? (
        <Modal
          title="Delete conversation?"
          description="This will permanently delete the conversation file. This action cannot be undone."
          onCancel={() => threadMgr.setPendingDeleteThreadId(null)}
          onConfirm={() => void confirmDeleteThread()}
        >
          <div className="flex items-center justify-end gap-2">
            <Button intent="ghost" size="sm" onClick={() => threadMgr.setPendingDeleteThreadId(null)}>
              Cancel
            </Button>
            <Button intent="danger" size="sm" onClick={() => void confirmDeleteThread()}>
              Delete
            </Button>
          </div>
        </Modal>
      ) : null}

      {showConnectionModal ? (
        <Modal
          title={connection === "reconnecting" ? "Connection lost" : "Reconnect failed"}
          description={
            connection === "reconnecting"
              ? `WebSocket disconnected. Retrying... (${Math.min(reconnectAttempts, retryLimit)}/${retryLimit})`
              : `Automatic retry stopped after ${retryLimit} attempts.`
          }
          onConfirm={connection === "disconnected" ? retryConnection : undefined}
        >
          {connection === "reconnecting" ? (
            <div className="text-sm text-muted">Please wait while we restore the session.</div>
          ) : (
            <div className="flex items-center justify-end gap-2">
              <Button intent="ghost" size="sm" onClick={retryConnection}>
                Retry now
              </Button>
            </div>
          )}
        </Modal>
      ) : null}
    </div>
  );
}
