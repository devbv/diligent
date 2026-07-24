// @summary Copyable account and session identifiers for support diagnostics

import { CopyButton } from "./CopyButton";
import { cardPaddingClasses, surfaceCardClasses } from "./ui-styles";

interface DiagnosticIdentifiersProps {
  sessionId?: string | null;
  accountId?: string | null;
}

function IdentifierRow({ label, value }: { label: string; value?: string | null }) {
  const available = Boolean(value?.trim());
  return (
    <div className="flex min-w-0 items-center gap-3 py-2 first:pt-0 last:pb-0">
      <div className="w-20 shrink-0 text-xs font-medium text-muted">{label}</div>
      <div className="min-w-0 flex-1 break-all font-mono text-xs text-text">{available ? value : "Unavailable"}</div>
      {available ? <CopyButton text={value!} ariaLabel={`Copy ${label}`} /> : null}
    </div>
  );
}

export function DiagnosticIdentifiers({ sessionId, accountId }: DiagnosticIdentifiersProps) {
  return (
    <div className={`${surfaceCardClasses} ${cardPaddingClasses} divide-y divide-border/40`}>
      <IdentifierRow label="Session ID" value={sessionId} />
      <IdentifierRow label="Account ID" value={accountId} />
    </div>
  );
}
