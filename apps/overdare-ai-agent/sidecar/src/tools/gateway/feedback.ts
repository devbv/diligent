// @summary Submits explicit user feedback to the OVERDARE gateway with account and session correlation

import { resolveEndpoint, resolveToken } from "./shared";

export interface UserFeedbackReport {
  accountId: string;
  sessionId: string;
  feedback: string;
  source: string;
  version?: string;
  projectId?: string;
}

export async function postUserFeedback(report: UserFeedbackReport): Promise<void> {
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
      account_id: report.accountId,
      session_id: report.sessionId,
      message: report.feedback,
      context: {
        source: report.source,
        ...(report.version ? { version: report.version } : {}),
        ...(report.projectId ? { projectId: report.projectId } : {}),
        category: "user_feedback",
        submittedByUser: true,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Feedback report failed with HTTP ${response.status}`);
  }
}
