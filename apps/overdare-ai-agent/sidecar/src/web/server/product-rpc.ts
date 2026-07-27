// @summary Intercepts Web-owned product requests before the closed Diligent runtime protocol

import type { JSONRPCResponse } from "@diligent/protocol";
import { ConsentSetParamsSchema, WEB_CONSENT_SET_METHOD, type WebConsentBackend } from "../shared/consent-protocol";
import {
  type FeedbackEnvironment,
  FeedbackReportParamsSchema,
  FeedbackReportResponseSchema,
  WEB_FEEDBACK_REPORT_METHOD,
  type WebFeedbackBackend,
} from "../shared/feedback-protocol";

interface WebRequestRouterOptions {
  consentBackend?: WebConsentBackend;
  feedbackBackend?: WebFeedbackBackend;
  feedbackEnvironment?: FeedbackEnvironment;
  accountId?: string;
  send(message: JSONRPCResponse): void;
  forward(raw: string | Buffer): void;
}

export async function routeWebRpcRequest(raw: string | Buffer, options: WebRequestRouterOptions): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    options.forward(raw);
    return;
  }

  if (!isProductRequest(value)) {
    options.forward(raw);
    return;
  }

  const id = typeof value.id === "string" || typeof value.id === "number" ? value.id : "unknown";
  if (id === "unknown") {
    options.send({ id, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  try {
    if (value.method === WEB_CONSENT_SET_METHOD) {
      if (!options.consentBackend) {
        options.send({ id, error: { code: -32601, message: "Consent backend not available" } });
        return;
      }
      const params = ConsentSetParamsSchema.safeParse(value.params ?? {});
      if (!params.success) {
        options.send({ id, error: { code: -32602, message: "Invalid params", data: params.error.message } });
        return;
      }
      const result = await options.consentBackend.set(params.data);
      options.send({ id, result });
      return;
    }

    if (!options.feedbackBackend) {
      options.send({ id, error: { code: -32601, message: "Feedback backend not available" } });
      return;
    }
    const accountId = options.accountId?.trim();
    if (!accountId) {
      options.send({ id, error: { code: -32000, message: "Account ID not available" } });
      return;
    }
    if (!options.feedbackEnvironment) {
      options.send({ id, error: { code: -32000, message: "Feedback environment not available" } });
      return;
    }
    const params = FeedbackReportParamsSchema.safeParse(value.params ?? {});
    if (!params.success) {
      options.send({ id, error: { code: -32602, message: "Invalid params", data: params.error.message } });
      return;
    }
    const result = FeedbackReportResponseSchema.parse(
      await options.feedbackBackend.submit({
        ...params.data,
        ...options.feedbackEnvironment,
        accountId,
      }),
    );
    options.send({ id, result });
  } catch (error) {
    const code =
      error instanceof Error && typeof (error as Error & { code?: unknown }).code === "number"
        ? (error as Error & { code: number }).code
        : -32000;
    options.send({ id, error: { code, message: error instanceof Error ? error.message : String(error) } });
  }
}

function isProductRequest(value: unknown): value is { id: unknown; method: string; params?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "method" in value &&
    ((value as { method?: unknown }).method === WEB_CONSENT_SET_METHOD ||
      (value as { method?: unknown }).method === WEB_FEEDBACK_REPORT_METHOD)
  );
}
