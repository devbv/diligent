// @summary Tests for rendering ranked knowledge within configured limits
import { describe, expect, it } from "bun:test";
import { buildKnowledgeSection } from "@diligent/runtime/knowledge";
import { makeKnowledgeEntry } from "../helpers/knowledge";

describe("Knowledge Injector", () => {
  it("builds section from entries", () => {
    const entries = [
      makeKnowledgeEntry({ type: "pattern", content: "Use Bun.spawn for process execution" }),
      makeKnowledgeEntry({ type: "preference", content: "Always use TypeScript strict mode" }),
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
      makeKnowledgeEntry({ content: `Knowledge item ${i} with some extra text to use tokens` }),
    );

    const section = buildKnowledgeSection(entries, 50);
    const lines = section.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThan(10);
  });

  it("uses configured maxItems when provided", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeKnowledgeEntry({ id: `m-${i}`, confidence: (10 - i) / 10, content: `Configured item ${i}` }),
    );

    const section = buildKnowledgeSection(entries, 8192, 5);
    const lines = section.split("\n").filter((line) => line.startsWith("- ["));

    expect(lines).toHaveLength(5);
    expect(lines[4]).toContain("Configured item 4");
    expect(section).not.toContain("Configured item 5");
  });
});
