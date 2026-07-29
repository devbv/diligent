// @summary Tests feedback RPC timeout and receipt parsing

import { expect, test } from "bun:test";
import { FEEDBACK_REPORT_TIMEOUT_MS, submitFeedbackRpc } from "../../../../src/web/client/lib/use-feedback-state";

test("submits feedback with the dedicated ten-second timeout", async () => {
  const calls: Array<{ method: string; params: unknown; timeoutMs: number | null }> = [];
  const receipt = await submitFeedbackRpc(
    {
      requestRaw: async (method: string, params: unknown, timeoutMs: number | null) => {
        calls.push({ method, params, timeoutMs });
        return {
          reportId: "report-789",
          reportedAt: "2026-07-24T08:00:01.000Z",
        };
      },
    },
    {
      clientReportId: "1cf50de8-8232-4bc9-8841-9f36b85ba86f",
      sessionId: "session-123",
      messageId: "persistent-message-id",
      category: "etc",
    },
  );

  expect(FEEDBACK_REPORT_TIMEOUT_MS).toBe(10_000);
  expect(calls).toEqual([
    {
      method: "feedback/report",
      params: {
        clientReportId: "1cf50de8-8232-4bc9-8841-9f36b85ba86f",
        sessionId: "session-123",
        messageId: "persistent-message-id",
        category: "etc",
      },
      timeoutMs: 10_000,
    },
  ]);
  expect(receipt.reportId).toBe("report-789");
});
