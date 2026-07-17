// @summary Chat-top app error banner for provider and runtime failures outside transcript history

import { ProviderErrorType, type ProviderName } from "@diligent/protocol";
import type { ActiveErrorState } from "../lib/thread-store";

interface ErrorBannerProps {
  error: ActiveErrorState;
  onOpenProviders?: (provider?: ProviderName) => void;
  onStartNewThread?: () => void;
  onRetry?: () => void;
}

export function ErrorBanner({ error, onOpenProviders, onStartNewThread, onRetry }: ErrorBannerProps) {
  const recoveryKind = error.recovery?.kind;
  const isAuthError =
    recoveryKind === "configure_provider" || (!error.recovery && error.providerErrorType === ProviderErrorType.Auth);
  const title = error.presented
    ? error.message
    : isAuthError && !error.recovery
      ? "Provider authentication failed"
      : error.name
        ? `${error.name}: ${error.message}`
        : error.message;
  const action =
    recoveryKind === "configure_provider" && onOpenProviders
      ? {
          label: "Reconnect",
          run: () =>
            onOpenProviders(error.recovery?.kind === "configure_provider" ? error.recovery.provider : undefined),
        }
      : recoveryKind === "start_new_thread" && onStartNewThread
        ? { label: "New chat", run: onStartNewThread }
        : recoveryKind === "retry" && onRetry
          ? { label: "Retry", run: onRetry }
          : !error.recovery && isAuthError && onOpenProviders
            ? { label: "Reconnect", run: () => onOpenProviders() }
            : undefined;

  return (
    <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-2" role="alert" aria-live="assertive">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-sm font-medium leading-relaxed text-text-soft">
            {title}
          </div>
          {isAuthError && !error.recovery ? (
            <div className="mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-muted">
              Reconnect this provider to continue.
            </div>
          ) : null}
        </div>
        {action ? (
          <button
            type="button"
            onClick={action.run}
            className="shrink-0 rounded-md border border-danger/40 bg-danger/15 px-2.5 py-1 text-xs font-medium text-danger transition hover:bg-danger/25"
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
