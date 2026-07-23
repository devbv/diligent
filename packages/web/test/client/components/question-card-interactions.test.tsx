// @summary DOM interaction tests for request_user_input question cards
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { isImeCompositionEvent, QuestionCard } from "../../../src/client/components/QuestionCard";

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

// The custom-answer input is a controlled field. When the agent streams tokens, the whole
// MessageList re-renders on every frame. If that cascade re-renders the focused QuestionCard,
// the browser re-selects the input text (Ctrl+A-like) and clobbers in-progress IME composition,
// so a mid-typing user sees their text highlighted and replaced. QuestionCard's props are
// referentially stable during streaming, so memoizing it must isolate it from those re-renders.
test("does not re-render when a parent re-renders with unchanged props", async () => {
  // Rendering reads request.questions; memo's shallow prop compare only touches the stable
  // `request` reference, so a getter hit means the component body actually re-ran.
  let renderReads = 0;
  const countingRequest = {
    get questions() {
      renderReads += 1;
      return request.questions;
    },
  };
  const streamingStableProps = {
    request: countingRequest as unknown as typeof request,
    answers: { purpose: "Movement", style: "Arc", control: "Auto" },
    onAnswerChange: () => {},
    onSubmit: () => {},
    onCancel: () => {},
  };

  let forceParentRerender: (() => void) | null = null;
  function Harness() {
    const [, setTick] = useState(0);
    forceParentRerender = () => setTick((tick) => tick + 1);
    return createElement(QuestionCard, streamingStableProps);
  }

  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(createElement(Harness));
  });
  expect(renderReads).toBeGreaterThan(0);
  const readsAfterMount = renderReads;

  // Simulate a streaming token: the parent re-renders but QuestionCard's props are unchanged.
  await act(async () => {
    forceParentRerender?.();
  });
  expect(renderReads).toBe(readsAfterMount);

  await act(async () => {
    root.unmount();
  });
  rootElement.remove();
});

test("submits complete answers when Enter is pressed in a question input", async () => {
  let submitCount = 0;
  let submittedAnswers: Record<string, string | string[]> | null = null;
  let updateAnswer: ((id: string, value: string | string[]) => void) | null = null;
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  function Harness() {
    const [answers, setAnswers] = useState<Record<string, string | string[]>>({
      purpose: "",
      style: "Arc",
      control: "Auto",
    });
    updateAnswer = (id, value) => setAnswers((current) => ({ ...current, [id]: value }));
    return createElement(QuestionCard, {
      request,
      answers,
      onAnswerChange: updateAnswer,
      onSubmit: () => {
        submitCount += 1;
        submittedAnswers = answers;
      },
      onCancel: () => {},
    });
  }

  await act(async () => {
    root.render(createElement(Harness));
  });

  const input = rootElement.querySelector<HTMLInputElement>('input[type="text"]');
  expect(input).not.toBeNull();
  await act(async () => {
    updateAnswer?.("purpose", "Fly slowly");
  });
  expect(input?.value).toBe("Fly slowly");
  const enterEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(async () => {
    input?.dispatchEvent(enterEvent);
  });

  expect(submitCount).toBe(1);
  expect(submittedAnswers).toEqual({ purpose: "Fly slowly", style: "Arc", control: "Auto" });
  expect(enterEvent.defaultPrevented).toBe(true);
  await act(async () => {
    root.unmount();
  });
  rootElement.remove();
});

test("does not submit incomplete answers when Enter is pressed in a question input", async () => {
  let submitCount = 0;
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(
      createElement(QuestionCard, {
        request,
        answers: { purpose: "Fly slowly", style: "Arc", control: "" },
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
  const enterEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(async () => {
    input?.dispatchEvent(enterEvent);
  });

  expect(submitCount).toBe(0);
  expect(enterEvent.defaultPrevented).toBe(true);
  await act(async () => {
    root.unmount();
  });
  rootElement.remove();
});

test("recognizes modern and legacy IME composition keyboard events", () => {
  expect(isImeCompositionEvent({ isComposing: true, keyCode: 13 })).toBe(true);
  expect(isImeCompositionEvent({ isComposing: false, keyCode: 229 })).toBe(true);
  expect(isImeCompositionEvent({ isComposing: false, keyCode: 13 })).toBe(false);
});
