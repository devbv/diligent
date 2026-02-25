import { describe, expect, it } from "bun:test";
import { buildSystemPromptWithKnowledge } from "../src/config/instructions";

describe("buildSystemPromptWithKnowledge", () => {
  it("includes knowledge section in system prompt", () => {
    const result = buildSystemPromptWithKnowledge("Base prompt", [], "## Project Knowledge\n- [pattern] Use Bun\n");
    expect(result).toContain("Base prompt");
    expect(result).toContain("## Project Knowledge");
    expect(result).toContain("[pattern] Use Bun");
    expect(result).toContain("add_knowledge tool");
  });

  it("includes instructions after knowledge section", () => {
    const result = buildSystemPromptWithKnowledge(
      "Base",
      [{ path: "/project/CLAUDE.md", content: "Project rules" }],
      "## Project Knowledge\n- [pattern] Use Bun\n",
    );

    const knowledgePos = result.indexOf("Project Knowledge");
    const instructionsPos = result.indexOf("Project rules");
    expect(knowledgePos).toBeLessThan(instructionsPos);
  });

  it("omits knowledge section when empty", () => {
    const result = buildSystemPromptWithKnowledge("Base", [], "");
    expect(result).not.toContain("## Project Knowledge");
    expect(result).toContain("add_knowledge tool");
  });

  it("includes additional instructions", () => {
    const result = buildSystemPromptWithKnowledge("Base", [], "", ["Custom instruction 1"]);
    expect(result).toContain("Custom instruction 1");
  });
});
