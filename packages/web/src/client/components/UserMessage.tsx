// @summary Right-aligned user message bubble with optional image attachments

import { useState } from "react";
import { type AgentContextItem, formatAgentContextItemLabel, getAgentContextItemKey } from "../lib/agent-native-bridge";

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
        className="inline-flex h-20 max-w-56 items-center gap-2 rounded-lg border border-border/100 bg-surface-dark px-3 text-xs text-muted"
        title={label}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-light text-2xs font-semibold text-muted">
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
      className="block overflow-hidden rounded-lg bg-surface-dark"
      title={label}
    >
      <img src={image.url} alt={label} className="max-h-48 max-w-56 object-cover" onError={() => setFailed(true)} />
    </a>
  );
}

export function UserMessage({ text, images = [], contextItems = [] }: UserMessageProps) {
  return (
    <div className="flex justify-end py-1 pb-8">
      <div className="max-w-message rounded-md bg-surface-light px-3.5 py-2">
        {contextItems.length > 0 ? (
          <div className="mb-3 flex flex-wrap justify-end gap-2">
            {contextItems.map((item) => (
              <span
                key={getAgentContextItemKey(item)}
                className="inline-flex max-w-full items-center rounded-full border border-border/100 bg-surface-dark px-2.5 py-1 text-xs text-muted"
                title={formatAgentContextItemLabel(item)}
              >
                <span className="truncate">{formatAgentContextItemLabel(item)}</span>
              </span>
            ))}
          </div>
        ) : null}
        {images.length > 0 ? (
          <div className="mb-3 flex flex-wrap justify-end gap-2">
            {images.map((image, index) => (
              <UserImageAttachment key={`${image.url}-${index}`} image={image} />
            ))}
          </div>
        ) : null}
        {text ? (
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-7 text-text">{text}</p>
        ) : null}
      </div>
    </div>
  );
}
