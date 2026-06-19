// @summary Tests for inline question input multi-select rendering and submission
import { describe, expect, test } from "bun:test";
import { QuestionInput } from "../../../src/tui/components/question-input";

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("QuestionInput", () => {
  test("renders multi-select options with clear checkbox glyphs", () => {
    const input = new QuestionInput(
      {
        question: "Choose next steps",
        options: [
          { label: "Fix UI", description: "Recommended" },
          { label: "Wait", description: "No changes" },
        ],
        allowMultiple: true,
      },
      () => {},
    );

    let plain = input.render(80).map(stripAnsi).join("\n");
    expect(plain).toContain("☐ Fix UI");
    expect(plain).not.toContain("[ ]");

    input.handleInput(" ");
    plain = input.render(80).map(stripAnsi).join("\n");

    expect(plain).toContain("☑ Fix UI");
    expect(plain).toContain("☐ Wait");
    expect(plain).not.toContain("[x]");
    expect(plain).not.toContain("[ ]");
  });
});
