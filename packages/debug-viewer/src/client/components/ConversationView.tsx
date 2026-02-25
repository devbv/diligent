import { useEffect, useMemo, useRef } from "react";
import { pairToolCalls } from "../lib/toolPairing.js";
import { buildSessionTree, getLinearPath, hasForking } from "../lib/tree.js";
import type { SessionEntry } from "../lib/types.js";
import { MessageCard } from "./MessageCard.js";

interface ConversationViewProps {
  entries: SessionEntry[];
  onSelectEntry: (entry: unknown) => void;
  loading: boolean;
  highlightEntryId?: string | null;
}

export function ConversationView({ entries, onSelectEntry, loading, highlightEntryId }: ConversationViewProps) {
  const endRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => buildSessionTree(entries), [entries]);
  const linearPath = useMemo(() => getLinearPath(tree), [tree]);
  const toolPairs = useMemo(() => pairToolCalls(entries), [entries]);
  const forking = useMemo(() => hasForking(tree), [tree]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: linearPath is the intentional trigger for auto-scroll
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [linearPath]);

  // Scroll to highlighted entry
  useEffect(() => {
    if (highlightEntryId) {
      const el = document.getElementById(`entry-${highlightEntryId}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightEntryId]);

  if (loading) {
    return <div className="conversation-loading">Loading conversation...</div>;
  }

  if (entries.length === 0) {
    return <div className="conversation-empty">No entries in this session</div>;
  }

  return (
    <div className="conversation-view">
      {forking && <div className="forking-notice">This session has branching. Showing main branch.</div>}
      {linearPath.map((entry) => (
        <div key={entry.id} id={`entry-${entry.id}`} className={highlightEntryId === entry.id ? "highlight" : ""}>
          <MessageCard entry={entry} toolPairs={toolPairs} onSelectEntry={onSelectEntry} />
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
