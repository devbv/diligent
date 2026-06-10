// @summary Main application component: RPC setup and JSX rendering (state managed by useAppState)

import { AppHeader } from "./components/AppHeader";
import { AppOverlays } from "./components/AppOverlays";
import { InputDock } from "./components/InputDock";
import { KnowledgeManagerModal } from "./components/KnowledgeManagerModal";
import { MessageList } from "./components/MessageList";
import { Panel } from "./components/Panel";
import { PlanPanel } from "./components/PlanPanel";
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

  const { hasProvider, effectiveHasProvider, contextWindow } = providerMgr;
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
            onNewThread={() => void threadMgr.startNewThread()}
            onOpenThread={(id) => void threadMgr.openThread(id)}
            onDeleteThread={(id) => threadMgr.setPendingDeleteThreadId(id)}
          />
        </div>

        <Panel className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-surface-dark !rounded-none !border-0">
          <AppHeader
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

          {!hasProvider && state.items.length > 0 ? (
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
            onSend={actions.handleSend}
            onSteer={steeringQueue.handleSteer}
            onInterrupt={actions.handleInterrupt}
            onCompactionClick={actions.handleCompactionClick}
            isCompacting={state.isCompacting}
            canSend={canSend}
            canSteer={steeringQueue.canSteer}
            threadStatus={state.threadStatus}
            mode={state.mode}
            onModeChange={actions.handleModeChange}
            effort={effort}
            onEffortChange={actions.handleEffortChange}
            currentModel={providerMgr.currentModel}
            availableModels={providerMgr.availableModels}
            onModelChange={actions.handleModelChange}
            usage={state.usage}
            currentContextTokens={state.currentContextTokens}
            contextWindow={contextWindow}
            hasProvider={hasProvider}
            supportsVision={supportsVision}
            supportsThinking={supportsThinking}
            pendingImages={pendingImagePreviews}
            contextItems={activeContextItems}
            isUploadingImages={isUploadingImages}
            onAddImages={actions.handleAddImagesToDock}
            onRemoveImage={actions.handleRemovePendingImage}
            onRemoveContextItem={removeActiveContextItem}
            onClearContextItems={clearActiveContextItems}
            onSlashCommand={actions.handleSlashCommand}
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

      <AppOverlays
        toast={state.toast}
        onDismissToast={() => dispatch({ type: "clear_toast" })}
        showProviderModal={showProviderModal}
        providers={providerMgr.providers}
        focusedProvider={focusedProvider}
        oauthPending={oauthPending}
        oauthError={oauthError}
        onSetProviderKey={providerMgr.handleSetProviderKey}
        onRemoveProviderKey={providerMgr.handleRemoveProviderKey}
        onOAuthStart={async (provider) => {
          setOauthPending(true);
          setOauthError(null);
          return providerMgr.handleOAuthStart(provider);
        }}
        onOAuthCancel={providerMgr.handleOAuthCancel}
        onCloseProviderModal={() => {
          setShowProviderModal(false);
          setFocusedProvider(null);
          setOauthError(null);
        }}
        pendingDeleteThreadId={threadMgr.pendingDeleteThreadId}
        onCancelDelete={() => threadMgr.setPendingDeleteThreadId(null)}
        onConfirmDelete={threadMgr.confirmDeleteThread}
        showConnectionModal={showConnectionModal}
        connection={connection}
        reconnectAttempts={reconnectAttempts}
        retryLimit={retryLimit}
        retryConnection={retryConnection}
      />
    </div>
  );
}
