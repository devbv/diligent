// @summary Modal for direct user CRUD management of knowledge entries over RPC

import type { KnowledgeEntry, KnowledgeType, KnowledgeUpdateParams } from "@diligent/protocol";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Modal } from "./Modal";
import { TextArea } from "./TextArea";

interface KnowledgeManagerModalProps {
  threadId?: string | null;
  onList: (threadId?: string) => Promise<{ data: KnowledgeEntry[] }>;
  onUpdate: (params: KnowledgeUpdateParams) => Promise<{ entry?: KnowledgeEntry; deleted?: boolean }>;
  onClose: () => void;
  className?: string;
}

const KNOWLEDGE_TYPES: KnowledgeType[] = ["pattern", "discovery", "preference", "correction", "backlog"];

const KNOWLEDGE_TYPE_STYLES: Record<KnowledgeType, string> = {
  pattern: "border-knowledge-pattern/30 bg-knowledge-pattern/10 text-knowledge-pattern",
  backlog: "border-knowledge-backlog/30 bg-knowledge-backlog/10 text-knowledge-backlog",
  discovery: "border-knowledge-discovery/30 bg-knowledge-discovery/10 text-knowledge-discovery",
  preference: "border-knowledge-preference/30 bg-knowledge-preference/10 text-knowledge-preference",
  correction: "border-knowledge-correction/30 bg-knowledge-correction/10 text-knowledge-correction",
};

interface EntryDraft {
  type: KnowledgeType;
  content: string;
  confidence: string;
  tags: string;
}

interface EditingState {
  id: string;
  draft: EntryDraft;
}

type SortMode = "newest" | "oldest" | "confidence_desc" | "confidence_asc";

function normalizeTags(tags: string): string[] | undefined {
  const values = tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function parseConfidence(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

function toDraft(entry: KnowledgeEntry): EntryDraft {
  return {
    type: entry.type,
    content: entry.content,
    confidence: String(entry.confidence),
    tags: entry.tags?.join(", ") ?? "",
  };
}

export function KnowledgeManagerModal({ threadId, onList, onUpdate, onClose, className }: KnowledgeManagerModalProps) {
  const idPrefix = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<KnowledgeType | "all">("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");

  const searchInputId = `${idPrefix}-search`;
  const typeFilterId = `${idPrefix}-type-filter`;
  const sortModeId = `${idPrefix}-sort-mode`;

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const filteredEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matchesQuery = (entry: KnowledgeEntry) => {
      if (!query) return true;
      const haystack = [entry.content, entry.type, entry.tags?.join(" ") ?? "", entry.sessionId ?? ""]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    };

    const matchesType = (entry: KnowledgeEntry) => typeFilter === "all" || entry.type === typeFilter;

    const sorted = [...entries].filter((entry) => matchesQuery(entry) && matchesType(entry));
    sorted.sort((a, b) => {
      switch (sortMode) {
        case "oldest":
          return Date.parse(a.timestamp) - Date.parse(b.timestamp);
        case "confidence_desc":
          return b.confidence - a.confidence || Date.parse(b.timestamp) - Date.parse(a.timestamp);
        case "confidence_asc":
          return a.confidence - b.confidence || Date.parse(b.timestamp) - Date.parse(a.timestamp);
        default:
          return Date.parse(b.timestamp) - Date.parse(a.timestamp);
      }
    });
    return sorted;
  }, [entries, search, sortMode, typeFilter]);

  const loadEntries = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await onList(threadId ?? undefined);
      setEntries(result.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load knowledge entries");
    } finally {
      setLoading(false);
    }
  }, [onList, threadId]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const cancelEditing = () => {
    setEditing(null);
  };

  const updateEntryDraft = (updater: (draft: EntryDraft) => EntryDraft) => {
    setEditing((current) => (current ? { ...current, draft: updater(current.draft) } : current));
  };

  const beginEdit = (entry: KnowledgeEntry) => {
    setEditing({ id: entry.id, draft: toDraft(entry) });
    setError(null);
  };

  const submitEdit = async (): Promise<void> => {
    if (!editing) return;
    const content = editing.draft.content.trim();
    if (!content) {
      setError("Content is required");
      return;
    }

    const confidence = parseConfidence(editing.draft.confidence.trim());
    if (confidence === null) {
      setError("Confidence must be a number between 0 and 1");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await onUpdate({
        action: "upsert",
        threadId: threadId ?? undefined,
        id: editing.id,
        type: editing.draft.type,
        content,
        tags: normalizeTags(editing.draft.tags),
      });
      if (!result.entry) {
        throw new Error("Knowledge update did not return an entry");
      }
      setEntries((current) => current.map((entry) => (entry.id === editing.id ? result.entry! : entry)));
      cancelEditing();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save knowledge entry");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDeleteId) return;
    setSaving(true);
    setError(null);
    try {
      const result = await onUpdate({
        action: "delete",
        threadId: threadId ?? undefined,
        id: pendingDeleteId,
      });
      if (!result.deleted) {
        setError("Knowledge entry not found");
      } else {
        setEntries((current) => current.filter((entry) => entry.id !== pendingDeleteId));
        if (editing?.id === pendingDeleteId) cancelEditing();
      }
      setPendingDeleteId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to delete knowledge entry");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={className ?? "fixed inset-0 z-50 bg-overlay/35"} role="presentation" onClick={onClose}>
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Knowledge"
        tabIndex={-1}
        className="absolute inset-0 z-10 flex flex-col border border-border/100 bg-surface-default p-5 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-text">Knowledge</h2>
            <p className="mt-1 text-sm text-muted">Review, edit, and delete reusable knowledge directly.</p>
          </div>
          <button
            type="button"
            aria-label="Close knowledge panel"
            onClick={onClose}
            className="rounded-md border border-border/100 bg-fill-secondary px-2 py-1 text-xs text-muted transition hover:bg-fill-ghost-hover hover:text-text"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {error ? <p className="text-sm text-danger">{error}</p> : null}

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-text">
                Entries ({filteredEntries.length}/{entries.length})
              </h3>
              <Button intent="ghost" size="sm" onClick={() => void loadEntries()} disabled={loading || saving}>
                Refresh
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_160px_180px]">
              <label htmlFor={searchInputId} className="text-xs text-muted">
                Search
                <Input
                  id={searchInputId}
                  aria-label="Search knowledge"
                  placeholder="Search content, tags, type"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <label htmlFor={typeFilterId} className="text-xs text-muted">
                Type
                <select
                  id={typeFilterId}
                  aria-label="Filter knowledge type"
                  className="mt-1 h-10 w-full rounded-md border border-border/100 bg-surface-dark px-2 text-sm text-text"
                  value={typeFilter}
                  onChange={(event) => setTypeFilter(event.target.value as KnowledgeType | "all")}
                >
                  <option value="all">all types</option>
                  {KNOWLEDGE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor={sortModeId} className="text-xs text-muted">
                Sort
                <select
                  id={sortModeId}
                  aria-label="Sort knowledge entries"
                  className="mt-1 h-10 w-full rounded-md border border-border/100 bg-surface-dark px-2 text-sm text-text"
                  value={sortMode}
                  onChange={(event) => setSortMode(event.target.value as SortMode)}
                >
                  <option value="newest">newest first</option>
                  <option value="oldest">oldest first</option>
                  <option value="confidence_desc">confidence high → low</option>
                  <option value="confidence_asc">confidence low → high</option>
                </select>
              </label>
            </div>

            {loading ? <p className="text-sm text-muted">Loading knowledge entries…</p> : null}

            {!loading && filteredEntries.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/100 bg-surface-dark px-3 py-3 text-sm text-muted">
                {entries.length === 0 ? "No knowledge entries yet." : "No entries match the current filters."}
              </div>
            ) : null}

            <div className="space-y-2">
              {filteredEntries.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-border/100 bg-surface-dark px-3 py-3">
                  {editing?.id === entry.id ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="text-sm font-semibold text-text">Editing entry</h4>
                        <div className="flex items-center gap-1">
                          <Button intent="ghost" size="sm" onClick={cancelEditing} disabled={saving}>
                            Cancel
                          </Button>
                          <Button size="sm" onClick={() => void submitEdit()} disabled={saving}>
                            {saving ? "Saving…" : "Save"}
                          </Button>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                        <label className="text-xs text-muted">
                          Type
                          <select
                            className="mt-1 h-10 w-full rounded-md border border-border/100 bg-surface-default px-2 text-sm text-text"
                            value={editing.draft.type}
                            onChange={(event) =>
                              updateEntryDraft((current) => ({ ...current, type: event.target.value as KnowledgeType }))
                            }
                          >
                            {KNOWLEDGE_TYPES.map((type) => (
                              <option key={type} value={type}>
                                {type}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label htmlFor={`${idPrefix}-${entry.id}-confidence`} className="text-xs text-muted">
                          Confidence (0..1)
                          <Input
                            id={`${idPrefix}-${entry.id}-confidence`}
                            value={editing.draft.confidence}
                            onChange={(event) =>
                              updateEntryDraft((current) => ({ ...current, confidence: event.target.value }))
                            }
                          />
                        </label>
                        <label htmlFor={`${idPrefix}-${entry.id}-tags`} className="text-xs text-muted">
                          Tags (comma separated)
                          <Input
                            id={`${idPrefix}-${entry.id}-tags`}
                            value={editing.draft.tags}
                            onChange={(event) =>
                              updateEntryDraft((current) => ({ ...current, tags: event.target.value }))
                            }
                          />
                        </label>
                      </div>
                      <label htmlFor={`${idPrefix}-${entry.id}-content`} className="block text-xs text-muted">
                        Content
                        <TextArea
                          id={`${idPrefix}-${entry.id}-content`}
                          maxRows={8}
                          value={editing.draft.content}
                          onChange={(event) =>
                            updateEntryDraft((current) => ({ ...current, content: event.target.value }))
                          }
                        />
                      </label>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${KNOWLEDGE_TYPE_STYLES[entry.type]}`}
                          >
                            {entry.type}
                          </span>
                          <span className="text-xs text-muted">conf {entry.confidence.toFixed(2)}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label="Edit knowledge entry"
                            title="Edit"
                            onClick={() => beginEdit(entry)}
                            disabled={saving}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/100 bg-fill-secondary text-sm text-muted transition hover:bg-fill-ghost-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            aria-label="Delete knowledge entry"
                            title="Delete"
                            onClick={() => setPendingDeleteId(entry.id)}
                            disabled={saving}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/100 bg-fill-secondary text-sm text-muted transition hover:border-danger/40 hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            🗑
                          </button>
                        </div>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-text">{entry.content}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                        <span>{new Date(entry.timestamp).toLocaleString()}</span>
                        {entry.tags && entry.tags.length > 0 ? <span>tags: {entry.tags.join(", ")}</span> : null}
                        {entry.sessionId ? <span>session: {entry.sessionId}</span> : null}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {pendingDeleteId ? (
        <Modal
          title="Delete knowledge entry?"
          description="This will permanently remove the entry from knowledge.jsonl."
          onCancel={() => setPendingDeleteId(null)}
          onConfirm={() => void confirmDelete()}
        >
          <div className="flex items-center justify-end gap-2">
            <Button intent="ghost" size="sm" onClick={() => setPendingDeleteId(null)}>
              Cancel
            </Button>
            <Button intent="danger" size="sm" onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
