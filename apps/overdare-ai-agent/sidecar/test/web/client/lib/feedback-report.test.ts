// @summary Tests response report target derivation and receipt copy

import { expect, test } from "bun:test";
import {
  createFeedbackReportTarget,
  formatFeedbackReceiptToast,
  formatFeedbackSubmitError,
} from "../../../../src/web/client/lib/feedback-report";
import { RpcRequestError } from "../../../../src/web/client/lib/rpc-client";

test("derives a response target from the persistent message id and a two-line preview", () => {
  expect(
    createFeedbackReportTarget({
      id: "render:assistant-1",
      messageId: "persistent-assistant-id",
      kind: "assistant",
      text: "  First response line  \n\n  Second response line  \nThird response line",
      thinking: "",
      contentBlocks: [],
      thinkingDone: true,
      timestamp: Date.parse("2026-07-24T08:00:00.000Z"),
    }),
  ).toEqual({
    kind: "response",
    messageId: "persistent-assistant-id",
    preview: "First response line\nSecond response line",
  });
});

test("derives a request target without using the render key", () => {
  expect(
    createFeedbackReportTarget({
      id: "remote-user-temporary-key",
      messageId: "persistent-user-id",
      kind: "user",
      text: "  First request line  \nSecond request line\nThird request line",
      images: [],
      timestamp: Date.parse("2026-07-24T08:00:00.000Z"),
    }),
  ).toEqual({
    kind: "request",
    messageId: "persistent-user-id",
    preview: "First request line\nSecond request line",
  });
});

test("uses target-specific preview fallbacks for non-text messages", () => {
  expect(
    createFeedbackReportTarget({
      id: "image-request",
      messageId: "persistent-image-request",
      kind: "user",
      text: "",
      images: [{ url: "blob:image" }],
      timestamp: 1,
    }).preview,
  ).toBe("Request with attachment");

  expect(
    createFeedbackReportTarget({
      id: "structured-response",
      messageId: "persistent-structured-response",
      kind: "assistant",
      text: "",
      thinking: "",
      contentBlocks: [
        {
          type: "web_search_result",
          toolUseId: "search-1",
          provider: "openai",
          results: [{ url: "https://example.com", title: "Example result" }],
        },
      ],
      thinkingDone: true,
      timestamp: 2,
    }).preview,
  ).toBe("Structured response");
});

test("uses a general success toast without exposing the receipt id", () => {
  expect(formatFeedbackReceiptToast()).toBe("Report sent. We'll take a look.");
});

test("formats rate-limit errors from structured RPC data without parsing strings", () => {
  expect(formatFeedbackSubmitError(new RpcRequestError(-32000, "gateway rejected", { httpStatus: 429 }))).toBe(
    "Too many reports. Please try again later.",
  );
  expect(formatFeedbackSubmitError(new Error("HTTP 429 in unrelated text"))).toBe(
    "Couldn't send your report. Please try again in a moment.",
  );
});
