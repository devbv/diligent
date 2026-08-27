// @summary Web-owned user feedback RPC schemas and backend contract for the OVERDARE product surface

import { z } from "zod";

export const WEB_FEEDBACK_REPORT_METHOD = "feedback/report";

const UtcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "Expected a UTC timestamp");

export const FeedbackCategorySchema = z.enum(["stalled", "error", "etc"]);
export type FeedbackCategory = z.infer<typeof FeedbackCategorySchema>;

export const FeedbackReportParamsSchema = z
  .object({
    clientReportId: z.string().uuid(),
    sessionId: z.string().trim().min(1).max(256),
    messageId: z.string().trim().min(1).max(256),
    category: FeedbackCategorySchema,
    description: z.string().trim().max(1000).optional(),
  })
  .strict();
export type FeedbackReportParams = z.infer<typeof FeedbackReportParamsSchema>;

export const FeedbackReportResponseSchema = z
  .object({
    reportId: z.string().trim().min(1).max(256),
    reportedAt: UtcTimestampSchema,
  })
  .strict();
export type FeedbackReportResponse = z.infer<typeof FeedbackReportResponseSchema>;

export type FeedbackReportInput = FeedbackReportParams;

export interface WebFeedbackBackend {
  submit(input: FeedbackReportInput): Promise<FeedbackReportResponse>;
}
