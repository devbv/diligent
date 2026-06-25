// @summary Unit tests for request_user_input completeness checks

import { expect, test } from "bun:test";
import { isUserInputComplete } from "../../../src/client/lib/user-input-completeness";

test("requires every request_user_input question to have a non-empty answer", () => {
  const request = {
    questions: [
      {
        id: "purpose",
        header: "Purpose",
        question: "What should flying do?",
        options: [{ label: "Movement", description: "Move to another location." }],
      },
      {
        id: "style",
        header: "Style",
        question: "How should it fly?",
        options: [{ label: "Arc", description: "Use a jump-like arc." }],
      },
      {
        id: "control",
        header: "Control",
        question: "Who controls it?",
        options: [{ label: "Auto", description: "Play as an automatic spawn effect." }],
      },
    ],
  };

  expect(isUserInputComplete(request, { purpose: "Movement" })).toBe(false);
  expect(isUserInputComplete(request, { purpose: "Movement", style: "Arc", control: "" })).toBe(false);
  expect(isUserInputComplete(request, { purpose: "Movement", style: "Arc", control: "Auto" })).toBe(true);
});

test("treats empty multi-select arrays as incomplete", () => {
  const request = {
    questions: [
      {
        id: "effects",
        header: "Effects",
        question: "Pick effects",
        allow_multiple: true,
        options: [{ label: "Trail", description: "Leave a motion trail." }],
      },
    ],
  };

  expect(isUserInputComplete(request, { effects: [] })).toBe(false);
  expect(isUserInputComplete(request, { effects: ["   "] })).toBe(false);
  expect(isUserInputComplete(request, { effects: ["Trail"] })).toBe(true);
});
