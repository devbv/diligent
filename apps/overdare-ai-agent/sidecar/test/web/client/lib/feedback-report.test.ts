// @summary Tests response report target derivation and receipt copy

import { expect, test } from "bun:test";
import { createFeedbackReportTarget, formatFeedbackReceiptToast } from "../../../../src/web/client/lib/feedback-report";

test("derives the message id, response timestamp, model, and a two-line preview", () => {
  expect(
    createFeedbackReportTarget({
      id: "item:assistant-1:7",
      kind: "assistant",
      text: "  First response line  \n\n  Second response line  \nThird response line",
      thinking: "",
      contentBlocks: [],
      thinkingDone: true,
      timestamp: Date.parse("2026-07-24T08:00:00.000Z"),
      model: { provider: "openai", modelId: "gpt-5" },
    }),
  ).toEqual({
    messageId: "item:assistant-1:7",
    preview: "First response line\nSecond response line",
    occurredAt: "2026-07-24T08:00:00.000Z",
    agentModel: "openai/gpt-5",
  });
});

test("does not invent a model when the response has no authoritative model", () => {
  expect(
    createFeedbackReportTarget({
      id: "item:assistant-2:8",
      kind: "assistant",
      text: "Completed.",
      thinking: "",
      contentBlocks: [],
      thinkingDone: true,
      timestamp: Date.parse("2026-07-24T08:00:00.000Z"),
    }),
  ).not.toHaveProperty("agentModel");
});

test("formats the server receipt id in the success toast", () => {
  expect(formatFeedbackReceiptToast("report-789")).toBe("신고가 접수되었습니다 (#report-789)");
});
