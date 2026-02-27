import { marked } from "marked";
import { useState } from "react";
import type {
  AssistantMessageEntry,
  CompactionEntry,
  ContentBlock,
  SessionEntry,
  ToolCallPair,
  UserMessageEntry,
} from "../lib/types.js";
import { ToolCallCard } from "./ToolCallCard.js";

interface MessageCardProps {
  entry: SessionEntry;
  toolPairs: Map<string, ToolCallPair>;
  onSelectEntry: (entry: unknown) => void;
}

function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

function blockKey(block: ContentBlock, index: number): string {
  if (block.type === "tool_call") return `tc-${block.id}`;
  return `${block.type}-${index}`;
}

function UserMessageCard({
  entry,
  onSelectEntry,
}: {
  entry: UserMessageEntry;
  onSelectEntry: (entry: unknown) => void;
}) {
  const content = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: debug viewer message cards
    <div className="message-card user-message" onClick={() => onSelectEntry(entry)}>
      <div className="message-role-badge user">User</div>
      <div className="message-content">{content}</div>
    </div>
  );
}

function AssistantMessageCard({
  entry,
  toolPairs,
  onSelectEntry,
}: {
  entry: AssistantMessageEntry;
  toolPairs: Map<string, ToolCallPair>;
  onSelectEntry: (entry: unknown) => void;
}) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: debug viewer message cards
    <div className="message-card assistant-message" onClick={() => onSelectEntry(entry)}>
      <div className="message-header">
        <span className="message-role-badge assistant">Assistant</span>
        <span className="message-model">{entry.model}</span>
        <span className="message-usage">{entry.usage.inputTokens + entry.usage.outputTokens} tokens</span>
      </div>

      <div className="message-blocks">
        {entry.content.map((block, i) => {
          if (block.type === "thinking") {
            return (
              <div key={blockKey(block, i)} className="thinking-block">
                <button
                  type="button"
                  className="thinking-toggle"
                  onClick={(e) => {
                    e.stopPropagation();
                    setThinkingExpanded(!thinkingExpanded);
                  }}
                >
                  {thinkingExpanded ? "\u25BC" : "\u25B6"} Thinking
                </button>
                {thinkingExpanded && <pre className="thinking-content">{block.thinking}</pre>}
              </div>
            );
          }

          if (block.type === "image") {
            const { media_type, data } = block.source;
            return (
              <div key={blockKey(block, i)} className="image-block">
                <img src={`data:${media_type};base64,${data}`} alt="Image content" />
              </div>
            );
          }

          if (block.type === "text") {
            const html = renderMarkdown(block.text);
            // biome-ignore lint/security/noDangerouslySetInnerHtml: rendering trusted markdown from session data
            return <div key={blockKey(block, i)} className="text-block" dangerouslySetInnerHTML={{ __html: html }} />;
          }

          if (block.type === "tool_call") {
            const pair = toolPairs.get(block.id);
            return <ToolCallCard key={blockKey(block, i)} toolCall={block} pair={pair} onSelect={onSelectEntry} />;
          }

          return null;
        })}
      </div>
    </div>
  );
}

function CompactionCard({ entry, onSelectEntry }: { entry: CompactionEntry; onSelectEntry: (entry: unknown) => void }) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: debug viewer message cards
    <div className="message-card compaction-entry" onClick={() => onSelectEntry(entry)}>
      <div className="compaction-badge">Compaction</div>
      <div className="compaction-summary">{entry.summary}</div>
      {entry.details.modifiedFiles.length > 0 && (
        <div className="compaction-files">
          <span className="compaction-files-label">Modified:</span> {entry.details.modifiedFiles.join(", ")}
        </div>
      )}
      {entry.details.readFiles.length > 0 && (
        <div className="compaction-files">
          <span className="compaction-files-label">Read:</span> {entry.details.readFiles.join(", ")}
        </div>
      )}
    </div>
  );
}

export function MessageCard({ entry, toolPairs, onSelectEntry }: MessageCardProps) {
  if ("role" in entry && entry.role === "user") {
    return <UserMessageCard entry={entry as UserMessageEntry} onSelectEntry={onSelectEntry} />;
  }
  if ("role" in entry && entry.role === "assistant") {
    return (
      <AssistantMessageCard
        entry={entry as AssistantMessageEntry}
        toolPairs={toolPairs}
        onSelectEntry={onSelectEntry}
      />
    );
  }
  if ("type" in entry && entry.type === "compaction") {
    return <CompactionCard entry={entry as CompactionEntry} onSelectEntry={onSelectEntry} />;
  }
  // Skip tool_result entries (they're shown inline in tool call cards) and session_header
  return null;
}
