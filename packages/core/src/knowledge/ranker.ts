import type { KnowledgeEntry, KnowledgeType } from "./types";

/** D083: Type weights for ranking */
const TYPE_WEIGHTS: Record<KnowledgeType, number> = {
  correction: 1.5,
  preference: 1.3,
  pattern: 1.0,
  decision: 1.0,
  discovery: 0.8,
};

/** D083: 30-day half-life for time decay */
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Rank knowledge entries by recency x confidence x type weight.
 * D083: Filter out superseded entries, apply time decay.
 */
export function rankKnowledge(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  const supersededIds = new Set(entries.filter((e) => e.supersedes).map((e) => e.supersedes as string));
  const active = entries.filter((e) => !supersededIds.has(e.id));

  const now = Date.now();
  return active
    .map((entry) => {
      const age = now - Date.parse(entry.timestamp);
      const decay = 2 ** (-age / HALF_LIFE_MS);
      const score = entry.confidence * decay * (TYPE_WEIGHTS[entry.type] ?? 1.0);
      return { entry, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry);
}
