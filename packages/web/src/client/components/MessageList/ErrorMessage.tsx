// @summary Error row rendering for MessageList, including provider reconnect affordance

import type { RenderItem } from "../../lib/thread-store";

export function ErrorMessage({
  item,
  onOpenProviders,
}: {
  item: Extract<RenderItem, { kind: "error" }>;
  onOpenProviders?: () => void;
}) {
  const isAuthError = item.providerErrorType === "auth";
  return (
    <div className="py-1">
      <div className="max-w-full break-words rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-text-soft">
        <div className="whitespace-pre-wrap font-medium">
          {item.name ? `${item.name}: ${item.message}` : item.message}
        </div>
        {item.turnId ? <div className="mt-1 text-xs text-danger/80">Turn: {item.turnId}</div> : null}
        {isAuthError && onOpenProviders ? (
          <button
            type="button"
            onClick={onOpenProviders}
            className="mt-2 rounded-md border border-danger/40 bg-danger/15 px-2.5 py-1 text-xs font-medium text-danger transition hover:bg-danger/25"
          >
            Reconnect
          </button>
        ) : null}
      </div>
    </div>
  );
}
