// @summary Tests report transport orchestration and non-blocking analytics

import { expect, test } from "bun:test";
import { createFeedbackBackend } from "../src/feedback-backend";
import type { FeedbackReportInput } from "../src/web/shared/feedback-protocol";

const REPORT: FeedbackReportInput = {
  accountId: "account-1",
  sessionId: "session-1",
  messageId: "item:assistant-1:7",
  category: "wrong_result",
  description: "The output was incorrect.",
  occurredAt: "2026-07-24T08:00:00.000Z",
  os: "Darwin",
  osVersion: "25.5.0",
};

test("returns the gateway receipt and emits analytics after acceptance", async () => {
  const analytics: Array<{ accountId: string; category: string; sessionId: string }> = [];
  const backend = createFeedbackBackend({
    postReport: async () => ({
      reportId: "report-789",
      reportedAt: "2026-07-24T08:00:01.000Z",
    }),
    trackReport: async (event) => {
      analytics.push(event);
    },
  });

  await expect(backend.submit(REPORT)).resolves.toEqual({
    reportId: "report-789",
    reportedAt: "2026-07-24T08:00:01.000Z",
  });
  expect(analytics).toEqual([
    {
      accountId: "account-1",
      category: "wrong_result",
      sessionId: "session-1",
    },
  ]);
});

test("does not turn an accepted report into a failure when analytics rejects", async () => {
  const backend = createFeedbackBackend({
    postReport: async () => ({
      reportId: "report-789",
      reportedAt: "2026-07-24T08:00:01.000Z",
    }),
    trackReport: async () => {
      throw new Error("Bubo unavailable");
    },
  });

  await expect(backend.submit(REPORT)).resolves.toEqual({
    reportId: "report-789",
    reportedAt: "2026-07-24T08:00:01.000Z",
  });
});
