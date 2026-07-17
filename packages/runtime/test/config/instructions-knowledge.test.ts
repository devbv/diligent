// @summary Tests for system prompt building with knowledge injection
import { describe, expect, it } from "bun:test";
import { flattenSections } from "@diligent/core/prompt-contract";
import { buildSystemPromptWithKnowledge } from "@diligent/runtime/config";

describe("buildSystemPromptWithKnowledge", () => {
  it("includes knowledge section in system prompt", () => {
    const result = buildSystemPromptWithKnowledge("Base prompt", [], "## Project Knowledge\n- [pattern] Use Bun\n");
    const flat = flattenSections(result);
    expect(flat).toContain("Base prompt");
    expect(flat).toContain("## Project Knowledge");
    expect(flat).toContain("[pattern] Use Bun");
    expect(flat).toContain("search_knowledge and update_knowledge tools");
    expect(flat).toContain("exact id, id_prefix, or query text");
    expect(flat).toContain("Knowledge ids may be stable caller-defined keys or generated UUIDs");
    expect(flat).toContain("use stable ids for recurring entries");
    expect(flat).toContain("update_knowledge tool");
    expect(flat).toContain("Persist only user preferences");
    expect(flat).toContain("type `preference`");
    expect(flat).toContain("Do not create knowledge entries for patterns, discoveries, corrections, or backlog items");
    expect(flat).toContain("Do not save transient current-turn intent");
    expect(flat).toContain("in most cases it is immediate task intent, not knowledge");
  });

  it("includes instructions after knowledge section", () => {
    const result = buildSystemPromptWithKnowledge(
      "Base",
      [{ path: "/project/AGENTS.md", content: "Project rules" }],
      "## Project Knowledge\n- [pattern] Use Bun\n",
    );

    const flat = flattenSections(result);
    const knowledgePos = flat.indexOf("Project Knowledge");
    const instructionsPos = flat.indexOf("Project rules");
    expect(knowledgePos).toBeLessThan(instructionsPos);
  });

  it("omits knowledge section when empty", () => {
    const result = buildSystemPromptWithKnowledge("Base", [], "");
    const flat = flattenSections(result);
    expect(flat).not.toContain("## Project Knowledge");
    expect(flat).toContain("search_knowledge and update_knowledge tools");
  });

  it("includes additional instructions", () => {
    const result = buildSystemPromptWithKnowledge("Base", [], "", ["Custom instruction 1"]);
    const flat = flattenSections(result);
    expect(flat).toContain("Custom instruction 1");
  });

  it("includes agents section when provided", () => {
    const result = buildSystemPromptWithKnowledge(
      "Base",
      [],
      "",
      undefined,
      undefined,
      "## Available Agents\n- **code-reviewer**",
    );
    const flat = flattenSections(result);
    expect(flat).toContain("Available Agents");
    expect(flat).toContain("code-reviewer");
  });
});
