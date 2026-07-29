// @summary Tests report transport orchestration

import { expect, test } from "bun:test";
import { createFeedbackBackend } from "../src/feedback-backend";
import type { FeedbackReportInput } from "../src/web/shared/feedback-protocol";

const REPORT: FeedbackReportInput = {
  clientReportId: "1cf50de8-8232-4bc9-8841-9f36b85ba86f",
  sessionId: "session-1",
  messageId: "persistent-message-id",
  category: "error",
  description: "The output was incorrect.",
};

test("returns the gateway receipt without side-channel analytics", async () => {
  const submitted: FeedbackReportInput[] = [];
  const backend = createFeedbackBackend({
    postReport: async (report) => {
      submitted.push(report);
      return {
        reportId: "report-789",
        reportedAt: "2026-07-24T08:00:01.000Z",
      };
    },
  });

  await expect(backend.submit(REPORT)).resolves.toEqual({
    reportId: "report-789",
    reportedAt: "2026-07-24T08:00:01.000Z",
  });
  expect(submitted).toEqual([REPORT]);
});
