// @summary Modal shown when the WebSocket connection is lost or retry has failed
import { Button } from "./Button";
import { Modal } from "./Modal";
import { actionRowClasses } from "./ui-styles";

interface ConnectionModalProps {
  isReconnecting: boolean;
  reconnectAttempts: number;
  retryLimit: number;
  onRetry: () => void;
}

export function ConnectionModal({ isReconnecting, reconnectAttempts, retryLimit, onRetry }: ConnectionModalProps) {
  return (
    <Modal
      title={isReconnecting ? "Connection lost" : "Reconnect failed"}
      description={
        isReconnecting
          ? `WebSocket disconnected. Retrying... (${Math.min(reconnectAttempts, retryLimit)}/${retryLimit})`
          : `Automatic retry stopped after ${retryLimit} attempts.`
      }
      onConfirm={!isReconnecting ? onRetry : undefined}
    >
      {isReconnecting ? (
        <div className="text-sm text-muted">Please wait while we restore the session.</div>
      ) : (
        <div className={actionRowClasses}>
          <Button intent="ghost" size="sm" onClick={onRetry}>
            Retry now
          </Button>
        </div>
      )}
    </Modal>
  );
}
