// @summary Global overlay components: toast notification and application-level modals
import type { ProviderAuthStatus } from "@diligent/protocol";
import type { ConnectionState } from "../lib/rpc-client";
import type { ToastState } from "../lib/thread-store";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { ProviderSettingsModal } from "./ProviderSettingsModal";

interface AppOverlaysProps {
  toast: ToastState | null;
  onDismissToast: () => void;

  showProviderModal: boolean;
  providers: ProviderAuthStatus[];
  focusedProvider: string | null;
  oauthPending: boolean;
  oauthError: string | null;
  onSetProviderKey: (provider: string, apiKey: string) => Promise<void>;
  onRemoveProviderKey: (provider: string) => Promise<void>;
  onOAuthStart: (provider: string) => Promise<{ authUrl: string }>;
  onOAuthCancel: (provider: string) => Promise<void>;
  onCloseProviderModal: () => void;

  pendingDeleteThreadId: string | null;
  onCancelDelete: () => void;
  onConfirmDelete: () => Promise<void>;

  showConnectionModal: boolean;
  connection: ConnectionState;
  reconnectAttempts: number;
  retryLimit: number;
  retryConnection: () => void;
}

export function AppOverlays({
  toast,
  onDismissToast,
  showProviderModal,
  providers,
  focusedProvider,
  oauthPending,
  oauthError,
  onSetProviderKey,
  onRemoveProviderKey,
  onOAuthStart,
  onOAuthCancel,
  onCloseProviderModal,
  pendingDeleteThreadId,
  onCancelDelete,
  onConfirmDelete,
  showConnectionModal,
  connection,
  reconnectAttempts,
  retryLimit,
  retryConnection,
}: AppOverlaysProps) {
  return (
    <>
      {toast ? (
        <div
          className={`toast-animate fixed bottom-12 left-1/2 -translate-x-1/2 rounded-md border px-3 py-2 text-sm shadow-panel ${
            toast.kind === "error"
              ? "border-danger/40 bg-surface-default text-danger"
              : "border-accent/40 bg-surface-default text-accent"
          } ${toast.fatal ? "cursor-pointer" : ""}`}
          onClick={toast.fatal ? onDismissToast : undefined}
        >
          {toast.message}
          {toast.fatal && <span className="ml-2 opacity-50">×</span>}
        </div>
      ) : null}

      {showProviderModal ? (
        <ProviderSettingsModal
          providers={providers}
          focusProvider={focusedProvider ?? undefined}
          oauthPending={oauthPending}
          oauthError={oauthError}
          onSet={onSetProviderKey}
          onRemove={onRemoveProviderKey}
          onOAuthStart={onOAuthStart}
          onOAuthCancel={onOAuthCancel}
          onClose={onCloseProviderModal}
        />
      ) : null}

      {pendingDeleteThreadId ? (
        <Modal
          title="Delete conversation?"
          description="This will permanently delete the conversation file. This action cannot be undone."
          onCancel={onCancelDelete}
          onConfirm={() => void onConfirmDelete()}
        >
          <div className="flex items-center justify-end gap-2">
            <Button intent="ghost" size="sm" onClick={onCancelDelete}>
              Cancel
            </Button>
            <Button intent="danger" size="sm" onClick={() => void onConfirmDelete()}>
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
    </>
  );
}
