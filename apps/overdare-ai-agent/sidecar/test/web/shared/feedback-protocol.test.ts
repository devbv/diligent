// @summary Tests the Web-owned user feedback RPC contract

import { describe, expect, test } from "bun:test";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import {
  FeedbackCategorySchema,
  FeedbackReportParamsSchema,
  FeedbackReportResponseSchema,
  WEB_FEEDBACK_REPORT_METHOD,
} from "../../../src/web/shared/feedback-protocol";

describe("Web feedback protocol", () => {
  test("keeps feedback outside the shared Diligent protocol", () => {
    expect(WEB_FEEDBACK_REPORT_METHOD).toBe("feedback/report");
    expect(Object.values(DILIGENT_CLIENT_REQUEST_METHODS)).not.toContain(WEB_FEEDBACK_REPORT_METHOD);
  });

  test("accepts response-level report details without a client-supplied account id", () => {
    expect(
      FeedbackReportParamsSchema.parse({
        sessionId: "session-123",
        messageId: "item:assistant-1:7",
        category: "interrupted",
        description: "  The assistant stopped before applying the requested fix.  ",
        occurredAt: "2026-07-24T08:00:00.000Z",
        agentModel: "openai/gpt-5",
      }),
    ).toEqual({
      sessionId: "session-123",
      messageId: "item:assistant-1:7",
      category: "interrupted",
      description: "The assistant stopped before applying the requested fix.",
      occurredAt: "2026-07-24T08:00:00.000Z",
      agentModel: "openai/gpt-5",
    });
    expect(
      FeedbackReportParamsSchema.safeParse({
        sessionId: "session-123",
        accountId: "spoofed-account",
        category: "etc",
        occurredAt: "2026-07-24T08:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  test("requires a supported category and accepts an optional description up to 1000 characters", () => {
    expect(FeedbackCategorySchema.options).toEqual([
      "launch_fail",
      "interrupted",
      "no_response",
      "wrong_result",
      "etc",
    ]);
    const base = {
      sessionId: "session-123",
      category: "wrong_result",
      occurredAt: "2026-07-24T08:00:00.000Z",
    };
    expect(FeedbackReportParamsSchema.safeParse(base).success).toBe(true);
    expect(FeedbackReportParamsSchema.parse({ ...base, description: "   " }).description).toBe("");
    expect(FeedbackReportParamsSchema.safeParse({ ...base, description: "x".repeat(1000) }).success).toBe(true);
    expect(FeedbackReportParamsSchema.safeParse({ ...base, description: "x".repeat(1001) }).success).toBe(false);
    expect(FeedbackReportParamsSchema.safeParse({ ...base, category: "user_feedback" }).success).toBe(false);
    expect(FeedbackReportParamsSchema.safeParse({ ...base, sessionId: "" }).success).toBe(false);
    expect(FeedbackReportParamsSchema.safeParse({ ...base, occurredAt: "2026-07-24T17:00:00+09:00" }).success).toBe(
      false,
    );
  });

  test("requires the gateway receipt mapped to camel case", () => {
    expect(
      FeedbackReportResponseSchema.parse({
        reportId: "report-789",
        reportedAt: "2026-07-24T08:00:01.000Z",
      }),
    ).toEqual({
      reportId: "report-789",
      reportedAt: "2026-07-24T08:00:01.000Z",
    });
    expect(FeedbackReportResponseSchema.safeParse({ submitted: true }).success).toBe(false);
  });
});
