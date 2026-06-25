// @summary DOM interaction tests for request_user_input question cards
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QuestionCard } from "../../../src/client/components/QuestionCard";

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  void GlobalRegistrator.unregister();
});

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

test("does not submit when Enter is pressed in a question input", async () => {
  let submitCount = 0;
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(
      createElement(QuestionCard, {
        request,
        answers: { purpose: "Movement", style: "Arc", control: "Auto" },
        onAnswerChange: () => {},
        onSubmit: () => {
          submitCount += 1;
        },
        onCancel: () => {},
      }),
    );
  });

  const input = rootElement.querySelector<HTMLInputElement>('input[type="text"]');
  expect(input).not.toBeNull();
  await act(async () => {
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });

  expect(submitCount).toBe(0);

  const submitButton = Array.from(rootElement.querySelectorAll("button")).find(
    (button) => button.textContent === "Submit",
  );
  submitButton?.click();

  expect(submitCount).toBe(1);
  await act(async () => {
    root.unmount();
  });
  rootElement.remove();
});
