// @summary Submits explicit user feedback to the OVERDARE gateway with account and session correlation

import type { FeedbackReportInput, FeedbackReportResponse } from "../../web/shared/feedback-protocol";
import { resolveEndpoint, resolveToken } from "./shared";

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
      category: report.category,
      ...(report.description !== undefined ? { description: report.description } : {}),
      account_id: report.accountId,
      session_id: report.sessionId,
      ...(report.messageId ? { message_id: report.messageId } : {}),
      occurred_at: report.occurredAt,
      os: report.os,
      os_version: report.osVersion,
      ...(report.studioVersion ? { studio_version: report.studioVersion } : {}),
      ...(report.agentVersion ? { agent_version: report.agentVersion } : {}),
      ...(report.cpu ? { cpu: report.cpu } : {}),
      ...(report.gpu ? { gpu: report.gpu } : {}),
      ...(report.ram ? { ram: report.ram } : {}),
      ...(report.worldId ? { world_id: report.worldId } : {}),
      ...(report.projectId ? { project_id: report.projectId } : {}),
      ...(report.agentModel ? { agent_model: report.agentModel } : {}),
      ...(report.locale ? { locale: report.locale } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Feedback report failed with HTTP ${response.status}`);
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
