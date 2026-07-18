// @summary Web-owned consent RPC schemas and backend contract for the OVERDARE product surface

import { z } from "zod";

export const WEB_CONSENT_SET_METHOD = "consent/set";

export const ConsentStateSchema = z.object({
  noticeAcknowledged: z.boolean(),
  serviceImprovement: z.boolean(),
  privacyPolicyUrl: z.string(),
});
export type ConsentState = z.infer<typeof ConsentStateSchema>;

export const ConsentSetParamsSchema = z.object({
  noticeAcknowledged: z.boolean().optional(),
  serviceImprovement: z.boolean().optional(),
});
export type ConsentSetParams = z.infer<typeof ConsentSetParamsSchema>;

export interface WebConsentBackend {
  get(): ConsentState;
  refresh?(): Promise<void>;
  set(params: ConsentSetParams): ConsentState | Promise<ConsentState>;
}
