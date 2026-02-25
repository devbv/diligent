import { rankKnowledge } from "./ranker";
import type { KnowledgeEntry } from "./types";

/**
 * D083: Build "Project Knowledge" system prompt section.
 * Fits within token budget (chars/4 estimation).
 */
export function buildKnowledgeSection(entries: KnowledgeEntry[], budgetTokens: number): string {
  if (entries.length === 0) return "";

  const ranked = rankKnowledge(entries);
  const header = "## Project Knowledge\nThe following knowledge was accumulated from previous sessions:\n\n";
  let section = header;
  let estimatedTokens = Math.ceil(header.length / 4);

  for (const entry of ranked) {
    const line = `- [${entry.type}] ${entry.content}\n`;
    const lineTokens = Math.ceil(line.length / 4);
    if (estimatedTokens + lineTokens > budgetTokens) break;
    section += line;
    estimatedTokens += lineTokens;
  }

  return section;
}
