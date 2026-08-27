// @summary Submits an authenticated message report to the OVERDARE gateway

import type { FeedbackReportInput, FeedbackReportResponse } from "../../web/shared/feedback-protocol";
import { resolveEndpoint, resolveToken } from "./shared";

export class FeedbackGatewayError extends Error {
  readonly code = -32000;

  constructor(
    message: string,
    readonly data: { httpStatus: number },
  ) {
    super(message);
    this.name = "FeedbackGatewayError";
  }
}

export async function postUserFeedback(report: FeedbackReportInput): Promise<FeedbackReportResponse> {
  const token = await resolveToken();
  if (!token) {
    throw new Error("Feedback report failed: Gateway token is unavailable");
  }

  const response = await fetch(`${resolveEndpoint()}/v1/reports`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      client_report_id: report.clientReportId,
      category: report.category,
      ...(report.description !== undefined ? { description: report.description } : {}),
      session_id: report.sessionId,
      message_id: report.messageId,
    }),
  });

  if (!response.ok) {
    throw new FeedbackGatewayError("Feedback report failed", { httpStatus: response.status });
  }

  const payload = (await response.json()) as { report_id?: unknown; reported_at?: unknown };
  if (typeof payload.report_id !== "string" || typeof payload.reported_at !== "string") {
    throw new Error("Feedback report failed: Gateway returned an invalid receipt");
  }
  return {
    reportId: payload.report_id,
    reportedAt: payload.reported_at,
  };
}
