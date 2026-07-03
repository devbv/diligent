// @summary Removable composer chips for host-injected AgentNativeBridge context items

import { X } from "lucide-react";
import { type AgentContextItem, formatAgentContextItemLabel, getAgentContextItemKey } from "../lib/agent-native-bridge";

interface ComposerContextChipsProps {
  items: AgentContextItem[];
  onRemove: (key: string) => void;
  onClear: () => void;
}

export function ComposerContextChips({ items, onRemove, onClear }: ComposerContextChipsProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {items.map((item) => {
        const key = getAgentContextItemKey(item);
        return (
          <button
            key={key}
            type="button"
            onClick={() => onRemove(key)}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/100 bg-surface-light px-2.5 py-1 text-xs text-text transition hover:bg-fill-secondary"
            aria-label={`Remove ${formatAgentContextItemLabel(item)} context`}
            title={formatAgentContextItemLabel(item)}
          >
            <span className="truncate">{formatAgentContextItemLabel(item)}</span>
            <X aria-hidden="true" className="h-3 w-3 text-muted/80" strokeWidth={2} />
          </button>
        );
      })}
      {items.length > 1 ? (
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-muted transition hover:text-text"
          aria-label="Clear attached context"
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}
