// @summary Shared synthetic knowledge entry factory for runtime tests
import type { KnowledgeEntry } from "@diligent/runtime/knowledge";

export function makeKnowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: crypto.randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    type: "pattern",
    content: "Test knowledge",
    confidence: 0.8,
    ...overrides,
  };
}
