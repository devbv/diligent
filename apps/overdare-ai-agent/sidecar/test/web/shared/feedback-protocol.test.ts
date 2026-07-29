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

  test("accepts only the final report identifiers and user input", () => {
    expect(
      FeedbackReportParamsSchema.parse({
        clientReportId: "1cf50de8-8232-4bc9-8841-9f36b85ba86f",
        sessionId: "session-123",
        messageId: "persistent-message-id",
        category: "stalled",
        description: "  The assistant stopped before applying the requested fix.  ",
      }),
    ).toEqual({
      clientReportId: "1cf50de8-8232-4bc9-8841-9f36b85ba86f",
      sessionId: "session-123",
      messageId: "persistent-message-id",
      category: "stalled",
      description: "The assistant stopped before applying the requested fix.",
    });

    const removedFields = [
      "accountId",
      "requestText",
      "responseText",
      "targetType",
      "occurredAt",
      "isPartial",
      "agentModel",
      "os",
      "projectId",
      "locale",
    ];
    for (const field of removedFields) {
      expect(
        FeedbackReportParamsSchema.safeParse({
          clientReportId: "1cf50de8-8232-4bc9-8841-9f36b85ba86f",
          sessionId: "session-123",
          messageId: "persistent-message-id",
          category: "etc",
          [field]: "spoofed",
        }).success,
      ).toBe(false);
    }
  });

  test("requires a supported category and accepts an optional description up to 1000 characters", () => {
    expect(FeedbackCategorySchema.options).toEqual(["stalled", "error", "etc"]);
    const base = {
      clientReportId: "1cf50de8-8232-4bc9-8841-9f36b85ba86f",
      sessionId: "session-123",
      messageId: "persistent-message-id",
      category: "error",
    };
    expect(FeedbackReportParamsSchema.safeParse(base).success).toBe(true);
    expect(FeedbackReportParamsSchema.parse({ ...base, description: "   " }).description).toBe("");
    expect(FeedbackReportParamsSchema.safeParse({ ...base, description: "x".repeat(1000) }).success).toBe(true);
    expect(FeedbackReportParamsSchema.safeParse({ ...base, description: "x".repeat(1001) }).success).toBe(false);
    expect(FeedbackReportParamsSchema.safeParse({ ...base, category: "wrong_result" }).success).toBe(false);
    expect(FeedbackReportParamsSchema.safeParse({ ...base, clientReportId: "not-a-uuid" }).success).toBe(false);
    expect(FeedbackReportParamsSchema.safeParse({ ...base, sessionId: "" }).success).toBe(false);
    expect(FeedbackReportParamsSchema.safeParse({ ...base, messageId: "" }).success).toBe(false);
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
