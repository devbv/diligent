// @summary Tests the Web-owned user feedback RPC contract

import { describe, expect, test } from "bun:test";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import {
  FeedbackReportParamsSchema,
  FeedbackReportResponseSchema,
  WEB_FEEDBACK_REPORT_METHOD,
} from "../../../src/web/shared/feedback-protocol";

describe("Web feedback protocol", () => {
  test("keeps feedback outside the shared Diligent protocol", () => {
    expect(WEB_FEEDBACK_REPORT_METHOD).toBe("feedback/report");
    expect(Object.values(DILIGENT_CLIENT_REQUEST_METHODS)).not.toContain(WEB_FEEDBACK_REPORT_METHOD);
  });

  test("accepts a bounded session report without a client-supplied account id", () => {
    expect(
      FeedbackReportParamsSchema.parse({
        sessionId: "session-123",
        feedback: "The assistant stopped before applying the requested fix.",
      }),
    ).toEqual({
      sessionId: "session-123",
      feedback: "The assistant stopped before applying the requested fix.",
    });
    expect(
      FeedbackReportParamsSchema.safeParse({
        sessionId: "session-123",
        accountId: "spoofed-account",
        feedback: "Unexpected field",
      }).success,
    ).toBe(false);
    expect(FeedbackReportParamsSchema.safeParse({ sessionId: "", feedback: "Missing session" }).success).toBe(false);
    expect(FeedbackReportParamsSchema.safeParse({ sessionId: "session-123", feedback: "   " }).success).toBe(false);
  });

  test("requires an explicit submitted response", () => {
    expect(FeedbackReportResponseSchema.parse({ submitted: true })).toEqual({ submitted: true });
    expect(FeedbackReportResponseSchema.safeParse({ submitted: false }).success).toBe(false);
  });
});
