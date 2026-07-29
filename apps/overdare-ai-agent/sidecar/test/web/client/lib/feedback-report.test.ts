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
