// @summary Main application component: pure composition of hooks and sub-components

import { AppHeader } from "./components/AppHeader";
import { ConnectionModal } from "./components/ConnectionModal";
import { DeleteThreadModal } from "./components/DeleteThreadModal";
import { ErrorBanner } from "./components/ErrorBanner";
import { FirstRunNoticeModal } from "./components/FirstRunNoticeModal";
import { InputDock } from "./components/InputDock";
import { KnowledgeManagerModal } from "./components/KnowledgeManagerModal";
import { MessageList } from "./components/MessageList";
import { Panel } from "./components/Panel";
import { PlanPanel } from "./components/PlanPanel";
import { ProviderSettingsModal } from "./components/ProviderSettingsModal";
import { Sidebar } from "./components/Sidebar";
import { SteeringQueuePanel } from "./components/SteeringQueuePanel";
import { Toast } from "./components/Toast";
import { ToolSettingsModal } from "./components/ToolSettingsModal";
import { hasPendingUserInputTool } from "./lib/thread-utils";
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
    oauthPending,
    oauthError,
    attentionThreadIds,
    runtimeVersion,
    consent,
    updateConsent,
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
    showImageUploadIndicator,
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
    handleProviderModalClose,
    handleProviderOAuthStart,
    handleProviderOAuthCancel,
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

  useAgentNativeBridge({ updateContextItems: updateActiveContextItems });
  const hasBlockingPrompt = Boolean(approvalPrompt || questionPrompt || hasPendingUserInputTool(state.items));

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

          {state.activeError ? <ErrorBanner error={state.activeError} onOpenProviders={handleOpenProviders} /> : null}

          <MessageList
            items={state.items}
            threadStatus={state.threadStatus}
            threadCwd={state.activeThreadCwd ?? undefined}
            hasProvider={providerMgr.effectiveHasProvider}
            oauthPending={oauthPending}
            onOpenProviders={handleOpenProviders}
            onQuickConnectChatGPT={handleQuickConnectChatGPT}
            isCompacting={state.isCompacting}
            approvalPrompt={approvalPrompt}
            questionPrompt={questionPrompt}
            onLoadChildThread={loadChildThread}
          />

          {state.planState?.steps.some((s) => s.status !== "done") && <PlanPanel planState={state.planState!} />}

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
            hasBlockingPrompt={hasBlockingPrompt}
            supportsVision={supportsVision}
            supportsThinking={supportsThinking}
            pendingImages={pendingImagePreviews}
            contextItems={activeContextItems}
            isUploadingImages={isUploadingImages}
            showImageUploadIndicator={showImageUploadIndicator}
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
              consent={consent}
              onConsentChange={updateConsent}
              onList={listTools}
              onSave={saveTools}
              onDesktopNotificationsEnabledChange={setDesktopNotificationsEnabled}
              onOpenProviders={() => {
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

      {state.toast ? <Toast toast={state.toast} onDismiss={() => dispatch({ type: "clear_toast" })} /> : null}

      {showProviderModal ? (
        <ProviderSettingsModal
          providers={providerMgr.providers}
          focusProvider={focusedProvider ?? undefined}
          oauthPending={oauthPending}
          oauthError={oauthError}
          onSet={providerMgr.handleSetProviderKey}
          onRemove={providerMgr.handleRemoveProviderKey}
          onOAuthStart={handleProviderOAuthStart}
          onOAuthCancel={handleProviderOAuthCancel}
          onClose={handleProviderModalClose}
        />
      ) : null}

      {threadMgr.pendingDeleteThreadId ? (
        <DeleteThreadModal
          onCancel={() => threadMgr.setPendingDeleteThreadId(null)}
          onConfirm={() => void confirmDeleteThread()}
        />
      ) : null}

      {showConnectionModal ? (
        <ConnectionModal
          isReconnecting={connection === "reconnecting"}
          reconnectAttempts={reconnectAttempts}
          retryLimit={retryLimit}
          onRetry={retryConnection}
        />
      ) : null}

      {consent && !consent.noticeAcknowledged ? (
        <FirstRunNoticeModal
          privacyPolicyUrl={consent.privacyPolicyUrl}
          onGetStarted={() => void updateConsent({ noticeAcknowledged: true })}
        />
      ) : null}
    </div>
  );
}
