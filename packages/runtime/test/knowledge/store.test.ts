// @summary Tests for persistent knowledge storage
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendKnowledge, readKnowledge } from "@diligent/runtime/knowledge";
import { makeKnowledgeEntry } from "../helpers/knowledge";

describe("Knowledge Store", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("append and read roundtrip", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "knowledge-"));
    const entry = makeKnowledgeEntry({ content: "Use Bun.spawn" });

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
    await appendKnowledge(tmpDir, makeKnowledgeEntry({ content: "first" }));
    await appendKnowledge(tmpDir, makeKnowledgeEntry({ content: "second" }));
    await appendKnowledge(tmpDir, makeKnowledgeEntry({ content: "third" }));

    const entries = await readKnowledge(tmpDir);
    expect(entries).toHaveLength(3);
    expect(entries[0].content).toBe("first");
    expect(entries[2].content).toBe("third");
  });
});
