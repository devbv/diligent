// @summary Right-aligned user message bubble with optional image attachments

import { type AgentContextItem, formatAgentContextItemLabel, getAgentContextItemKey } from "../lib/agent-native-bridge";

interface UserMessageProps {
  text: string;
  images?: Array<{ url: string; fileName?: string; mediaType?: string }>;
  contextItems?: AgentContextItem[];
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
                className="inline-flex max-w-full items-center rounded-full border border-border/100 bg-surface-dark px-2.5 py-1 text-[11px] text-muted"
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
              <a
                key={`${image.url}-${index}`}
                href={image.url}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-lg bg-surface-dark"
              >
                <img
                  src={image.url}
                  alt={image.fileName ?? "Attached image"}
                  className="max-h-48 max-w-[220px] object-cover"
                />
              </a>
            ))}
          </div>
        ) : null}
        {text ? (
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-7 text-white">
            {text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
