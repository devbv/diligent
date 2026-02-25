import { useCallback, useMemo, useState } from "react";
import type { SessionEntry } from "../lib/types.js";

export interface SearchMatch {
  entryId: string;
  field: string;
  snippet: string;
}

export function useSearch(entries: SessionEntry[]) {
  const [query, setQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  const matches = useMemo(() => {
    if (!query || query.length < 2) return [];
    const q = query.toLowerCase();
    const results: SearchMatch[] = [];

    for (const entry of entries) {
      const id = entry.id;

      if ("role" in entry && entry.role === "user") {
        const content = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
        if (content.toLowerCase().includes(q)) {
          results.push({ entryId: id, field: "content", snippet: content.slice(0, 80) });
        }
      }

      if ("role" in entry && entry.role === "assistant") {
        for (const block of entry.content) {
          if (block.type === "text" && block.text.toLowerCase().includes(q)) {
            results.push({ entryId: id, field: "text", snippet: block.text.slice(0, 80) });
          }
          if (block.type === "tool_call") {
            const inputStr = JSON.stringify(block.input);
            if (inputStr.toLowerCase().includes(q)) {
              results.push({ entryId: id, field: `tool:${block.name}`, snippet: inputStr.slice(0, 80) });
            }
          }
        }
      }

      if ("role" in entry && entry.role === "tool_result") {
        if (entry.output.toLowerCase().includes(q)) {
          results.push({ entryId: id, field: "output", snippet: entry.output.slice(0, 80) });
        }
      }

      if ("type" in entry && entry.type === "compaction") {
        if (entry.summary.toLowerCase().includes(q)) {
          results.push({ entryId: id, field: "summary", snippet: entry.summary.slice(0, 80) });
        }
      }
    }

    return results;
  }, [entries, query]);

  const navigateNext = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex((prev) => (prev + 1) % matches.length);
  }, [matches]);

  const navigatePrev = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex((prev) => (prev - 1 + matches.length) % matches.length);
  }, [matches]);

  const currentMatch = matches[currentMatchIndex] ?? null;

  return {
    query,
    setQuery,
    matches,
    currentMatch,
    currentMatchIndex,
    navigateNext,
    navigatePrev,
  };
}
