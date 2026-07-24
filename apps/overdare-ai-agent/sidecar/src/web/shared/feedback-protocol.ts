// @summary Web-owned user feedback RPC schemas and backend contract for the OVERDARE product surface

import { z } from "zod";

export const WEB_FEEDBACK_REPORT_METHOD = "feedback/report";

export const FeedbackReportParamsSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(256),
    feedback: z.string().trim().min(1).max(4000),
  })
  .strict();
export type FeedbackReportParams = z.infer<typeof FeedbackReportParamsSchema>;

export const FeedbackReportResponseSchema = z.object({
  submitted: z.literal(true),
});
export type FeedbackReportResponse = z.infer<typeof FeedbackReportResponseSchema>;

export interface FeedbackReportInput extends FeedbackReportParams {
  accountId: string;
}

export interface WebFeedbackBackend {
  submit(input: FeedbackReportInput): Promise<void>;
}
