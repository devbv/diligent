// @summary Main application component: RPC setup and JSX rendering (state managed by useAppState)

import { Button } from "./components/Button";
import { AppHeaderBar } from "./components/AppHeaderBar";
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
import { useAgentNativeBridge } from "./lib/use-agent-native-bridge";
import { useAppState } from "./lib/use-app-state";
import { useProviderManager } from "./lib/use-provider-manager";
import { useRpcClient } from "./lib/use-rpc";

export function App() {
  const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/rpc`;
  const { rpcRef, connection, reconnectAttempts, retryConnection, retryLimit, showConnectionModal } =
    useRpcClient(wsUrl);
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
    showPlan,
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

  useAgentNativeBridge(updateActiveContextItems);

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
          <AppHeaderBar
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            threadStatus={state.threadStatus}
            isCompacting={state.isCompacting}
            threadTitle={threadTitle}
            onOpenKnowledge={() => {
              setShowToolModal(false);
              setShowKnowledgeModal(true);
            }}
            onOpenConfig={() => {
              setShowKnowledgeModal(false);
              setShowToolModal(true);
            }}
          />

          <MessageList
            items={state.items}
            threadStatus={state.threadStatus}
            threadCwd={state.activeThreadCwd ?? undefined}
            hasProvider={providerMgr.effectiveHasProvider}
            onOpenProviders={handleOpenProviders}
            oauthPending={oauthPending}
            onQuickConnectChatGPT={handleQuickConnectChatGPT}
            isCompacting={state.isCompacting}
            approvalPrompt={approvalPrompt}
            questionPrompt={questionPrompt}
            onLoadChildThread={loadChildThread}
          />

          {showPlan && <PlanPanel planState={state.planState!} />}

          <SteeringQueuePanel pendingSteers={state.pendingSteers} />

          {!providerMgr.hasProvider && state.items.length > 0 ? (
            <div className="mx-3 mb-2 flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-text-soft">
              <span>Provider disconnected.</span>
              <button
                type="button"
                onClick={handleOpenProviders}
                className="rounded-md border border-danger/40 bg-danger/15 px-2.5 py-1 text-xs font-medium text-danger transition hover:bg-danger/25"
              >
                Reconnect
              </button>
            </div>
          ) : null}

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
            contextWindow={providerMgr.contextWindow}
            hasProvider={providerMgr.hasProvider}
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
                setFocusedProvider(providerMgr.hasProvider ? null : "chatgpt");
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
          onOAuthCancel={async () => {
            await providerMgr.handleOAuthCancel("chatgpt");
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
