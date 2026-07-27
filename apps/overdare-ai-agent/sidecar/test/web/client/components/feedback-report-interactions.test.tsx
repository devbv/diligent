// @summary DOM interaction tests for response-level feedback reporting

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

const TARGET = {
  messageId: "item:assistant-1:7",
  preview: "First response line\nSecond response line",
  occurredAt: "2026-07-24T08:00:00.000Z",
  agentModel: "openai/gpt-5",
};

test("requires a category and submits the trimmed optional description", async () => {
  const submissions: Array<{ category: string; description?: string }> = [];
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(
      createElement(FeedbackReportModal, {
        sessionId: "session-123",
        accountId: "account-456",
        target: TARGET,
        onSubmit: async (submission) => {
          submissions.push(submission);
        },
        onCancel: () => {},
      }),
    );
  });

  const submit = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Report");
  const textarea = document.querySelector<HTMLTextAreaElement>("#feedback-report-description");
  const category = document.querySelector<HTMLInputElement>('input[name="feedback-category"][value="wrong_result"]');
  expect(submit).toBeDefined();
  expect(submit?.disabled).toBe(true);
  expect(textarea).not.toBeNull();
  expect(category).not.toBeNull();

  await act(async () => {
    category!.click();
    setTextareaValue(textarea!, "  The response ignored my selected object.  ");
  });
  expect(submit?.disabled).toBe(false);

  await act(async () => {
    submit?.click();
  });

  expect(submissions).toEqual([
    {
      category: "wrong_result",
      description: "The response ignored my selected object.",
    },
  ]);

  await act(async () => root.unmount());
  rootElement.remove();
});

test("keeps category and description for retry when submission fails", async () => {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(
      createElement(FeedbackReportModal, {
        sessionId: "session-123",
        accountId: "account-456",
        target: TARGET,
        onSubmit: async () => {
          throw new Error("Gateway unavailable");
        },
        onCancel: () => {},
      }),
    );
  });

  const textarea = document.querySelector<HTMLTextAreaElement>("#feedback-report-description");
  const category = document.querySelector<HTMLInputElement>('input[name="feedback-category"][value="interrupted"]');
  await act(async () => {
    category!.click();
    setTextareaValue(textarea!, "Please investigate this conversation.");
  });
  const submit = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Report");
  await act(async () => {
    submit?.click();
  });

  expect(document.body.textContent).toContain("Gateway unavailable");
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(category?.checked).toBe(true);
  expect(textarea?.value).toBe("Please investigate this conversation.");

  await act(async () => root.unmount());
  rootElement.remove();
});

test("blocks duplicate submission and closing while the report is in flight", async () => {
  let resolveSubmission: (() => void) | undefined;
  let submissionCount = 0;
  let cancelCount = 0;
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(
      createElement(FeedbackReportModal, {
        sessionId: "session-123",
        accountId: "account-456",
        target: TARGET,
        onSubmit: async () => {
          submissionCount += 1;
          await new Promise<void>((resolve) => {
            resolveSubmission = resolve;
          });
        },
        onCancel: () => {
          cancelCount += 1;
        },
      }),
    );
  });

  const category = document.querySelector<HTMLInputElement>('input[name="feedback-category"][value="etc"]');
  await act(async () => {
    category!.click();
  });
  const submit = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Report");
  const cancel = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Cancel");

  await act(async () => {
    submit?.click();
    submit?.click();
    await Promise.resolve();
  });

  expect(submissionCount).toBe(1);
  expect(submit?.disabled).toBe(true);
  expect(cancel?.disabled).toBe(true);
  cancel?.click();
  expect(cancelCount).toBe(0);

  await act(async () => {
    resolveSubmission?.();
  });
  await act(async () => root.unmount());
  rootElement.remove();
});
