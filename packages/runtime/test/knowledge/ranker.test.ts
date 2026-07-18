// @summary Tests for confidence-based knowledge ranking and supersession
import { describe, expect, it } from "bun:test";
import { rankKnowledge } from "@diligent/runtime/knowledge";
import { makeKnowledgeEntry } from "../helpers/knowledge";

describe("Knowledge Ranker", () => {
  it("filters superseded entries", () => {
    const old = makeKnowledgeEntry({ id: "old1", content: "old rule" });
    const replacement = makeKnowledgeEntry({ id: "new1", content: "new rule", supersedes: "old1" });

    const ranked = rankKnowledge([old, replacement]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].id).toBe("new1");
  });

  it("ranks by confidence only", () => {
    const low = makeKnowledgeEntry({ id: "low", type: "correction", confidence: 0.2 });
    const high = makeKnowledgeEntry({ id: "high", type: "discovery", confidence: 0.9 });

    const ranked = rankKnowledge([low, high]);
    expect(ranked[0].id).toBe("high");
  });

  it("ignores recency and ranks by confidence only", () => {
    const recent = makeKnowledgeEntry({ id: "r1", confidence: 0.8, timestamp: new Date().toISOString() });
    const old = makeKnowledgeEntry({
      id: "o1",
      confidence: 0.8,
      timestamp: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const ranked = rankKnowledge([old, recent]);
    expect(ranked.map((entry) => entry.id).sort()).toEqual(["o1", "r1"]);
  });

  it("returns empty for empty input", () => {
    expect(rankKnowledge([])).toEqual([]);
  });
});
