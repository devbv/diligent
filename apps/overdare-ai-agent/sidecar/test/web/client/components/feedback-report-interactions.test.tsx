// @summary DOM interaction tests for per-conversation feedback reporting

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackReportModal } from "../../../../src/web/client/components/FeedbackReportModal";

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  void GlobalRegistrator.unregister();
});

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  nativeSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

test("submits trimmed feedback for the selected conversation", async () => {
  const submissions: string[] = [];
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(
      createElement(FeedbackReportModal, {
        sessionId: "session-123",
        accountId: "account-456",
        onSubmit: async (feedback: string) => {
          submissions.push(feedback);
        },
        onCancel: () => {},
      }),
    );
  });

  const submit = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === "Submit report",
  );
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Feedback"]');
  expect(submit).toBeDefined();
  expect(submit?.disabled).toBe(true);
  expect(textarea).not.toBeNull();

  await act(async () => {
    setTextareaValue(textarea!, "  The response ignored my selected object.  ");
  });
  expect(submit?.disabled).toBe(false);

  await act(async () => {
    submit?.click();
  });

  expect(submissions).toEqual(["The response ignored my selected object."]);

  await act(async () => root.unmount());
  rootElement.remove();
});

test("keeps the report open and shows a retryable error when submission fails", async () => {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(
      createElement(FeedbackReportModal, {
        sessionId: "session-123",
        accountId: "account-456",
        onSubmit: async () => {
          throw new Error("Gateway unavailable");
        },
        onCancel: () => {},
      }),
    );
  });

  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Feedback"]');
  await act(async () => {
    setTextareaValue(textarea!, "Please investigate this conversation.");
  });
  const submit = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === "Submit report",
  );
  await act(async () => {
    submit?.click();
  });

  expect(document.body.textContent).toContain("Gateway unavailable");
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();

  await act(async () => root.unmount());
  rootElement.remove();
});
