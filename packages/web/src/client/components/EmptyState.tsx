// @summary Empty state with a central account connection call-to-action

import { Button } from "./Button";
import { emptyStateCardClasses } from "./ui-styles";

interface EmptyStateProps {
  hasProvider: boolean;
  oauthPending?: boolean;
  onOpenProviders: () => void;
  onQuickConnectChatGPT?: () => void;
}

export function EmptyState({ hasProvider, oauthPending, onOpenProviders, onQuickConnectChatGPT }: EmptyStateProps) {
  if (hasProvider) {
    return null;
  }

  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-16">
      <div className={emptyStateCardClasses}>
        <h2 className="mb-2 text-xl font-semibold text-text">Connect your AI account to start building</h2>
        <p className="text-sm leading-6 text-muted">Most users start with ChatGPT. Sign in once and continue.</p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Button
            type="button"
            onClick={() => {
              if (onQuickConnectChatGPT) {
                onQuickConnectChatGPT();
                return;
              }
              onOpenProviders();
            }}
            disabled={oauthPending}
            size="sm"
          >
            {oauthPending ? "Connecting…" : "Connect ChatGPT"}
          </Button>
          <Button type="button" onClick={onOpenProviders} intent="ghost" size="sm">
            More options
          </Button>
        </div>
      </div>
    </div>
  );
}
