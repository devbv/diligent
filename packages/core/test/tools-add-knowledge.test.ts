import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKnowledge } from "../src/knowledge/store";
import type { ToolContext } from "../src/tool/types";
import { createAddKnowledgeTool } from "../src/tools/add-knowledge";

function makeCtx(): ToolContext {
  return {
    toolCallId: "test-tc-1",
    signal: new AbortController().signal,
    approve: async () => "once" as const,
  };
}

describe("add_knowledge tool", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("saves knowledge entry to JSONL", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "knowledge-"));
    const tool = createAddKnowledgeTool(tmpDir, "session-123");

    const result = await tool.execute(
      { type: "pattern", content: "Use Bun.spawn for processes", confidence: 0.9 },
      makeCtx(),
    );

    expect(result.output).toContain("Knowledge saved");
    expect(result.output).toContain("pattern");
    expect(result.output).toContain("Use Bun.spawn");

    const entries = await readKnowledge(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("pattern");
    expect(entries[0].content).toBe("Use Bun.spawn for processes");
    expect(entries[0].confidence).toBe(0.9);
    expect(entries[0].sessionId).toBe("session-123");
  });

  it("uses default confidence of 0.8", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "knowledge-"));
    const tool = createAddKnowledgeTool(tmpDir);

    await tool.execute({ type: "preference", content: "Prefer dark mode", confidence: 0.8 }, makeCtx());

    const entries = await readKnowledge(tmpDir);
    expect(entries[0].confidence).toBe(0.8);
  });

  it("supports tags", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "knowledge-"));
    const tool = createAddKnowledgeTool(tmpDir);

    await tool.execute(
      {
        type: "decision",
        content: "Use Zod for validation",
        confidence: 0.9,
        tags: ["validation", "schema"],
      },
      makeCtx(),
    );

    const entries = await readKnowledge(tmpDir);
    expect(entries[0].tags).toEqual(["validation", "schema"]);
  });
});
