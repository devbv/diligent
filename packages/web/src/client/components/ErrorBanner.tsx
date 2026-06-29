// @summary Chat-top app error banner for provider and runtime failures outside transcript history

import type { ActiveErrorState } from "../lib/thread-store";

interface ErrorBannerProps {
  error: ActiveErrorState;
  onOpenProviders?: () => void;
}

export function ErrorBanner({ error, onOpenProviders }: ErrorBannerProps) {
  const isAuthError = error.providerErrorType === "auth";
  const hasPlainProviderCopy = error.providerErrorType === "context_overflow";
  const title = isAuthError
    ? "Provider authentication failed"
    : hasPlainProviderCopy
      ? error.message
      : error.name
        ? `${error.name}: ${error.message}`
        : error.message;

  return (
    <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-2" role="alert" aria-live="assertive">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-sm font-medium leading-relaxed text-text-soft">
            {title}
          </div>
          {isAuthError ? (
            <div className="mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-muted">
              Reconnect this provider to continue.
            </div>
          ) : null}
        </div>
        {isAuthError && onOpenProviders ? (
          <button
            type="button"
            onClick={onOpenProviders}
            className="shrink-0 rounded-md border border-danger/40 bg-danger/15 px-2.5 py-1 text-xs font-medium text-danger transition hover:bg-danger/25"
          >
            Reconnect
          </button>
        ) : null}
      </div>
    </div>
  );
}
