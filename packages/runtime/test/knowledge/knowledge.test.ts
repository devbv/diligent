// @summary Tests for knowledge storage, ranking, and injection
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeEntry } from "@diligent/runtime/knowledge";
import { appendKnowledge, buildKnowledgeSection, rankKnowledge, readKnowledge } from "@diligent/runtime/knowledge";

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: crypto.randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    type: "pattern",
    content: "Test knowledge",
    confidence: 0.8,
    ...overrides,
  };
}

describe("Knowledge Store", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("append and read roundtrip", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "knowledge-"));
    const entry = makeEntry({ content: "Use Bun.spawn" });

    await appendKnowledge(tmpDir, entry);
    const entries = await readKnowledge(tmpDir);

    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe("Use Bun.spawn");
    expect(entries[0].id).toBe(entry.id);
  });

  it("reads from empty store", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "knowledge-"));
    const entries = await readKnowledge(tmpDir);
    expect(entries).toEqual([]);
  });

  it("appends multiple entries", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "knowledge-"));
    await appendKnowledge(tmpDir, makeEntry({ content: "first" }));
    await appendKnowledge(tmpDir, makeEntry({ content: "second" }));
    await appendKnowledge(tmpDir, makeEntry({ content: "third" }));

    const entries = await readKnowledge(tmpDir);
    expect(entries).toHaveLength(3);
    expect(entries[0].content).toBe("first");
    expect(entries[2].content).toBe("third");
  });
});

describe("Knowledge Ranker", () => {
  it("filters superseded entries", () => {
    const old = makeEntry({ id: "old1", content: "old rule" });
    const replacement = makeEntry({
      id: "new1",
      content: "new rule",
      supersedes: "old1",
    });

    const ranked = rankKnowledge([old, replacement]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].id).toBe("new1");
  });

  it("ranks by confidence only", () => {
    const low = makeEntry({ id: "low", type: "correction", confidence: 0.2 });
    const high = makeEntry({ id: "high", type: "discovery", confidence: 0.9 });

    const ranked = rankKnowledge([low, high]);
    expect(ranked[0].id).toBe("high");
  });

  it("ignores recency and ranks by confidence only", () => {
    const recent = makeEntry({
      id: "r1",
      confidence: 0.8,
      timestamp: new Date().toISOString(),
    });
    const old = makeEntry({
      id: "o1",
      confidence: 0.8,
      timestamp: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days ago
    });

    const ranked = rankKnowledge([old, recent]);
    expect(ranked.map((entry) => entry.id).sort()).toEqual(["o1", "r1"]);
  });

  it("returns empty for empty input", () => {
    expect(rankKnowledge([])).toEqual([]);
  });
});

describe("Knowledge Injector", () => {
  it("builds section from entries", () => {
    const entries = [
      makeEntry({ type: "pattern", content: "Use Bun.spawn for process execution" }),
      makeEntry({ type: "preference", content: "Always use TypeScript strict mode" }),
    ];

    const section = buildKnowledgeSection(entries, 8192);
    expect(section).toContain("## Project Knowledge");
    expect(section).toContain("[pattern] Use Bun.spawn");
    expect(section).toContain("[preference] Always use TypeScript strict mode");
  });

  it("returns empty string for no entries", () => {
    expect(buildKnowledgeSection([], 8192)).toBe("");
  });

  it("respects token budget", () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      makeEntry({ content: `Knowledge item ${i} with some extra text to use tokens` }),
    );

    const section = buildKnowledgeSection(entries, 50); // very small budget
    // Should have header + only a few entries
    const lines = section.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThan(10);
  });

  it("uses configured maxItems when provided", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ id: `m-${i}`, confidence: (10 - i) / 10, content: `Configured item ${i}` }),
    );

    const section = buildKnowledgeSection(entries, 8192, 5);
    const lines = section.split("\n").filter((line) => line.startsWith("- ["));

    expect(lines).toHaveLength(5);
    expect(lines[4]).toContain("Configured item 4");
    expect(section).not.toContain("Configured item 5");
  });
});
