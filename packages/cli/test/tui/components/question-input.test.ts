// @summary Tests that QuestionInput returns option.value (e.g. an assetId) instead of the label when present.

import { describe, expect, test } from "bun:test";
import { QuestionInput } from "../../../src/tui/components/question-input";

describe("QuestionInput value mapping", () => {
  test("single select returns option.value when present", () => {
    let result: string | string[] | null = "unset";
    const input = new QuestionInput(
      { question: "Pick an asset", options: [{ label: "Katana, Rusty", description: "MODEL", value: "6584600" }] },
      (value) => {
        result = value;
      },
    );

    input.handleInput("\r"); // Enter submits the focused (first) option
    expect(result).toBe("6584600");
  });

  test("single select falls back to label when value is absent", () => {
    let result: string | string[] | null = "unset";
    const input = new QuestionInput({ question: "Pick", options: [{ label: "Yes", description: "" }] }, (value) => {
      result = value;
    });

    input.handleInput("\r");
    expect(result).toBe("Yes");
  });
});
