// @summary Web-owned user feedback RPC schemas and backend contract for the OVERDARE product surface

import { z } from "zod";

export const WEB_FEEDBACK_REPORT_METHOD = "feedback/report";

const UtcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "Expected a UTC timestamp");

export const FeedbackCategorySchema = z.enum(["launch_fail", "interrupted", "no_response", "wrong_result", "etc"]);
export type FeedbackCategory = z.infer<typeof FeedbackCategorySchema>;

export const FeedbackReportParamsSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(256),
    messageId: z.string().trim().min(1).max(256).optional(),
    category: FeedbackCategorySchema,
    description: z.string().trim().max(1000).optional(),
    occurredAt: UtcTimestampSchema,
    agentModel: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type FeedbackReportParams = z.infer<typeof FeedbackReportParamsSchema>;

export const FeedbackEnvironmentSchema = z
  .object({
    os: z.string().trim().min(1).max(128),
    osVersion: z.string().trim().min(1).max(256),
    studioVersion: z.string().trim().min(1).max(128).optional(),
    agentVersion: z.string().trim().min(1).max(128).optional(),
    cpu: z.string().trim().min(1).max(256).optional(),
    gpu: z.string().trim().min(1).max(256).optional(),
    ram: z.string().trim().min(1).max(128).optional(),
    worldId: z.string().trim().min(1).max(256).optional(),
    projectId: z.string().trim().min(1).max(256).optional(),
    locale: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type FeedbackEnvironment = z.infer<typeof FeedbackEnvironmentSchema>;

export const FeedbackReportResponseSchema = z
  .object({
    reportId: z.string().trim().min(1).max(256),
    reportedAt: UtcTimestampSchema,
  })
  .strict();
export type FeedbackReportResponse = z.infer<typeof FeedbackReportResponseSchema>;

export interface FeedbackReportInput extends FeedbackReportParams, FeedbackEnvironment {
  accountId: string;
}

export interface WebFeedbackBackend {
  submit(input: FeedbackReportInput): Promise<FeedbackReportResponse>;
}
