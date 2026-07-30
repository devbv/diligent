// @summary Removable composer chips for host-injected AgentNativeBridge context items

import {
  type AgentContextItem,
  formatAgentContextItemDisplayLabel,
  formatAgentContextItemLabel,
  getAgentContextItemKey,
} from "../lib/agent-native-bridge";
import { ContextItemIcon } from "./ContextItemIcon";
import { X } from "./icons";

interface ComposerContextChipsProps {
  items: AgentContextItem[];
  onRemove: (key: string) => void;
}

export function ComposerContextChips({ items, onRemove }: ComposerContextChipsProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Attached context"
      className="flex min-h-5 max-h-24 max-w-full shrink-0 flex-wrap content-start items-center gap-1 overflow-y-auto"
    >
      {items.map((item) => {
        const key = getAgentContextItemKey(item);
        const label = formatAgentContextItemLabel(item);
        return (
          <button
            key={key}
            type="button"
            onClick={() => onRemove(key)}
            className="inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-[2px] bg-[#353C44] px-1 py-0.5 font-[Arial] text-xs font-normal leading-4 text-[#DCE2E8] transition hover:bg-[rgba(120,135,156,0.24)]"
            aria-label={`Remove ${label} context`}
            title={label}
          >
            <span className="flex min-w-0 items-center gap-0.5">
              <ContextItemIcon item={item} />
              <span className="truncate">{formatAgentContextItemDisplayLabel(item)}</span>
            </span>
            <X aria-hidden="true" className="h-3 w-3 shrink-0 text-[#88929C]" strokeWidth={2} />
          </button>
        );
      })}
    </section>
  );
}
