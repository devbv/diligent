// @summary DOM interaction tests for request and response feedback reporting

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackReportModal } from "../../../../src/web/client/components/FeedbackReportModal";
import { MessageActions } from "../../../../src/web/client/components/MessageActions";
import { RpcRequestError } from "../../../../src/web/client/lib/rpc-client";

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

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((button) => button.textContent === label);
}

const TARGET = {
  kind: "response" as const,
  messageId: "persistent-assistant-id",
  preview: "First response line\nSecond response line",
};

test("requires one of three categories and submits a trimmed optional description", async () => {
  const submissions: Array<{ category: string; description?: string; clientReportId: string }> = [];
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(
      createElement(FeedbackReportModal, {
        target: TARGET,
        onSubmit: async (submission) => {
          submissions.push(submission);
        },
        onCancel: () => {},
      }),
    );
  });

  const submit = findButton("Submit");
  const textarea = document.querySelector<HTMLTextAreaElement>("#feedback-report-description");
  const category = document.querySelector<HTMLInputElement>('input[name="feedback-category"][value="error"]');
  expect(document.querySelectorAll('input[name="feedback-category"]')).toHaveLength(3);
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

  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    category: "error",
    description: "The response ignored my selected object.",
  });
  expect(submissions[0]?.clientReportId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

  await act(async () => root.unmount());
  rootElement.remove();
});

test("submits with a UUID v4 fallback when crypto.randomUUID is unavailable", async () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues(bytes: Uint8Array) {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
        return bytes;
      },
    },
  });

  const submissions: Array<{ clientReportId: string }> = [];
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  try {
    await act(async () => {
      root.render(
        createElement(FeedbackReportModal, {
          target: TARGET,
          onSubmit: async (submission) => {
            submissions.push(submission);
          },
          onCancel: () => {},
        }),
      );
    });

    await act(async () => {
      document.querySelector<HTMLInputElement>('input[name="feedback-category"][value="etc"]')?.click();
      findButton("Submit")?.click();
    });

    expect(submissions).toEqual([{ category: "etc", clientReportId: "00010203-0405-4607-8809-0a0b0c0d0e0f" }]);
  } finally {
    await act(async () => root.unmount());
    rootElement.remove();
    if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("keeps input and the same client report id when retrying after failure", async () => {
  const submissions: Array<{ clientReportId: string }> = [];
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(
      createElement(FeedbackReportModal, {
        target: TARGET,
        onSubmit: async (submission) => {
          submissions.push(submission);
          if (submissions.length === 1) throw new Error("network failed");
        },
        onCancel: () => {},
      }),
    );
  });

  const textarea = document.querySelector<HTMLTextAreaElement>("#feedback-report-description");
  const category = document.querySelector<HTMLInputElement>('input[name="feedback-category"][value="stalled"]');
  await act(async () => {
    category!.click();
    setTextareaValue(textarea!, "Please investigate this response.");
  });

  await act(async () => {
    findButton("Submit")?.click();
  });
  expect(document.body.textContent).toContain("Couldn't send your report. Please try again in a moment.");
  expect(category?.checked).toBe(true);
  expect(textarea?.value).toBe("Please investigate this response.");

  await act(async () => {
    findButton("Submit")?.click();
  });
  expect(submissions).toHaveLength(2);
  expect(submissions[1]?.clientReportId).toBe(submissions[0]?.clientReportId);

  await act(async () => root.unmount());
  rootElement.remove();
});

test("shows a dedicated rate-limit message from structured RPC error data", async () => {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(
      createElement(FeedbackReportModal, {
        target: TARGET,
        onSubmit: async () => {
          throw new RpcRequestError(-32000, "gateway rejected", { httpStatus: 429 });
        },
        onCancel: () => {},
      }),
    );
  });

  await act(async () => {
    document.querySelector<HTMLInputElement>('input[name="feedback-category"][value="etc"]')?.click();
    findButton("Submit")?.click();
  });

  expect(document.body.textContent).toContain("Too many reports. Please try again later.");

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

  await act(async () => {
    document.querySelector<HTMLInputElement>('input[name="feedback-category"][value="etc"]')?.click();
  });

  const submit = findButton("Submit");
  const cancel = findButton("Cancel");
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

test("copies the message text and swaps the copy icon to a check", async () => {
  let copiedText = "";
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (value: string) => {
        copiedText = value;
      },
    },
    configurable: true,
  });

  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(
      createElement(MessageActions, {
        targetKind: "request",
        copyText: "Fix the selected object.",
        onReport: () => {},
        alwaysVisible: true,
      }),
    );
  });

  const copy = rootElement.querySelector<HTMLButtonElement>('button[title="Copy request"]');
  await act(async () => {
    copy?.click();
  });

  expect(copiedText).toBe("Fix the selected object.");
  expect(rootElement.querySelector('[data-icon="check"]')).not.toBeNull();

  await act(async () => root.unmount());
  rootElement.remove();
});
