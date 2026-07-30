// @summary Right-aligned user message bubble with optional image attachments

import { useState } from "react";
import {
  type AgentContextItem,
  formatAgentContextItemDisplayLabel,
  formatAgentContextItemLabel,
  getAgentContextItemKey,
} from "../lib/agent-native-bridge";
import { ContextItemIcon } from "./ContextItemIcon";

interface UserMessageImage {
  url: string;
  fileName?: string;
  mediaType?: string;
}

interface UserMessageProps {
  text: string;
  images?: UserMessageImage[];
  contextItems?: AgentContextItem[];
}

function UserImageAttachment({ image }: { image: UserMessageImage }) {
  const [failed, setFailed] = useState(false);
  const label = image.fileName ?? "Attached image";

  if (failed) {
    return (
      <a
        href={image.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-20 max-w-56 items-center gap-2 rounded border border-border/100 bg-surface-dark px-3 text-xs text-muted"
        title={label}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[2px] bg-surface-light text-2xs font-semibold text-muted">
          IMG
        </span>
        <span className="min-w-0">
          <span className="block truncate text-text">{label}</span>
          <span className="block truncate">Image unavailable</span>
        </span>
      </a>
    );
  }

  return (
    <a
      href={image.url}
      target="_blank"
      rel="noreferrer"
      className="block overflow-hidden rounded bg-surface-dark"
      title={label}
    >
      <img src={image.url} alt={label} className="max-h-48 max-w-56 object-cover" onError={() => setFailed(true)} />
    </a>
  );
}

export function UserMessage({ text, images = [], contextItems = [] }: UserMessageProps) {
  return (
    <div className="flex justify-end py-1 pb-8">
      <div className="flex max-w-message flex-col items-end gap-2 rounded-md bg-surface-light px-3.5 py-2">
        {images.length > 0 ? (
          <section aria-label="Image attachments" className="flex flex-wrap justify-end gap-2">
            {images.map((image, index) => (
              <UserImageAttachment key={`${image.url}-${index}`} image={image} />
            ))}
          </section>
        ) : null}
        {contextItems.length > 0 ? (
          <section aria-label="Attached context" className="flex flex-wrap justify-end gap-1">
            {contextItems.map((item) => (
              <span
                key={getAgentContextItemKey(item)}
                className="inline-flex h-5 max-w-full items-center gap-0.5 rounded-[2px] bg-[#353C44] px-1 py-0.5 font-[Arial] text-xs leading-4 text-[#DCE2E8]"
                title={formatAgentContextItemLabel(item)}
              >
                <ContextItemIcon item={item} />
                <span className="truncate">{formatAgentContextItemDisplayLabel(item)}</span>
              </span>
            ))}
          </section>
        ) : null}
        {text ? (
          <p className="self-stretch whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-7 text-text">
            {text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
