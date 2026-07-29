// @summary Tests Web-owned product request interception before DiligentAppServer dispatch

import { describe, expect, test } from "bun:test";
import { routeWebRpcRequest } from "../../../src/web/server/product-rpc";
import type { WebConsentBackend } from "../../../src/web/shared/consent-protocol";
import type {
  FeedbackReportInput,
  FeedbackReportResponse,
  WebFeedbackBackend,
} from "../../../src/web/shared/feedback-protocol";

const STATE = {
  noticeAcknowledged: true,
  serviceImprovement: true,
  privacyPolicyUrl: "https://example.test/privacy",
};

function backend(overrides: Partial<WebConsentBackend> = {}): WebConsentBackend {
  return {
    get: () => STATE,
    set: () => STATE,
    ...overrides,
  };
}

function feedbackBackend(submit: (input: FeedbackReportInput) => Promise<FeedbackReportResponse>): WebFeedbackBackend {
  return { submit };
}

describe("routeWebRpcRequest", () => {
  test("intercepts consent/set and returns the backend result without forwarding", async () => {
    const sent: unknown[] = [];
    const forwarded: unknown[] = [];
    await routeWebRpcRequest(JSON.stringify({ id: 7, method: "consent/set", params: { serviceImprovement: true } }), {
      consentBackend: backend(),
      send: (message) => sent.push(message),
      forward: (raw) => forwarded.push(raw),
    });

    expect(sent).toEqual([{ id: 7, result: STATE }]);
    expect(forwarded).toHaveLength(0);
  });

  test("forwards core requests unchanged", async () => {
    const raw = JSON.stringify({ id: 8, method: "thread/list", params: {} });
    const forwarded: unknown[] = [];
    await routeWebRpcRequest(raw, {
      consentBackend: backend(),
      send: () => {},
      forward: (value) => forwarded.push(value),
    });
    expect(forwarded).toEqual([raw]);
  });

  test("intercepts feedback/report and forwards only the reduced report input", async () => {
    const sent: unknown[] = [];
    const forwarded: unknown[] = [];
    const submitted: FeedbackReportInput[] = [];
    await routeWebRpcRequest(
      JSON.stringify({
        id: 12,
        method: "feedback/report",
        params: {
          clientReportId: "1cf50de8-8232-4bc9-8841-9f36b85ba86f",
          sessionId: "session-123",
          messageId: "persistent-message-id",
          category: "stalled",
          description: "The assistant stopped unexpectedly.",
        },
      }),
      {
        feedbackBackend: feedbackBackend(async (input) => {
          submitted.push(input);
          return { reportId: "report-789", reportedAt: "2026-07-24T08:00:01.000Z" };
        }),
        send: (message) => sent.push(message),
        forward: (raw) => forwarded.push(raw),
      },
    );

    expect(submitted).toEqual([
      {
        clientReportId: "1cf50de8-8232-4bc9-8841-9f36b85ba86f",
        sessionId: "session-123",
        messageId: "persistent-message-id",
        category: "stalled",
        description: "The assistant stopped unexpectedly.",
      },
    ]);
    expect(sent).toEqual([
      {
        id: 12,
        result: { reportId: "report-789", reportedAt: "2026-07-24T08:00:01.000Z" },
      },
    ]);
    expect(forwarded).toHaveLength(0);
  });

  test("rejects feedback/report when the product backend is unavailable", async () => {
    const withoutBackend: unknown[] = [];
    await routeWebRpcRequest(
      JSON.stringify({
        id: 13,
        method: "feedback/report",
        params: {
          clientReportId: "1cf50de8-8232-4bc9-8841-9f36b85ba86f",
          sessionId: "s1",
          messageId: "m1",
          category: "etc",
        },
      }),
      {
        send: (message) => withoutBackend.push(message),
        forward: () => {},
      },
    );
    expect(withoutBackend).toEqual([{ id: 13, error: { code: -32601, message: "Feedback backend not available" } }]);
  });

  test("preserves structured HTTP status data from feedback backend failures", async () => {
    const sent: unknown[] = [];
    const error = Object.assign(new Error("Feedback report failed"), {
      code: -32000,
      data: { httpStatus: 429 },
    });
    await routeWebRpcRequest(
      JSON.stringify({
        id: 14,
        method: "feedback/report",
        params: {
          clientReportId: "1cf50de8-8232-4bc9-8841-9f36b85ba86f",
          sessionId: "s1",
          messageId: "m1",
          category: "etc",
        },
      }),
      {
        feedbackBackend: feedbackBackend(async () => Promise.reject(error)),
        send: (message) => sent.push(message),
        forward: () => {},
      },
    );

    expect(sent).toEqual([
      {
        id: 14,
        error: {
          code: -32000,
          message: "Feedback report failed",
          data: { httpStatus: 429 },
        },
      },
    ]);
  });

  test("returns -32602 for invalid params", async () => {
    const sent: unknown[] = [];
    await routeWebRpcRequest(JSON.stringify({ id: 9, method: "consent/set", params: { serviceImprovement: "yes" } }), {
      consentBackend: backend(),
      send: (message) => sent.push(message),
      forward: () => {},
    });
    expect(sent).toMatchObject([{ id: 9, error: { code: -32602, message: "Invalid params" } }]);
  });

  test("returns -32601 when the Web host has no consent backend", async () => {
    const sent: unknown[] = [];
    await routeWebRpcRequest(JSON.stringify({ id: 10, method: "consent/set", params: {} }), {
      send: (message) => sent.push(message),
      forward: () => {},
    });
    expect(sent).toEqual([{ id: 10, error: { code: -32601, message: "Consent backend not available" } }]);
  });

  test("uses the standard server error shape for backend failures", async () => {
    const sent: unknown[] = [];
    await routeWebRpcRequest(JSON.stringify({ id: 11, method: "consent/set", params: {} }), {
      consentBackend: backend({ set: () => Promise.reject(new Error("gateway unavailable")) }),
      send: (message) => sent.push(message),
      forward: () => {},
    });
    expect(sent).toEqual([{ id: 11, error: { code: -32000, message: "gateway unavailable" } }]);
  });

  test("forwards notifications, responses, and malformed input to the existing peer", async () => {
    const values = [
      JSON.stringify({ method: "consent/set", params: {} }),
      JSON.stringify({ id: 1, result: {} }),
      "not json",
    ];
    const forwarded: unknown[] = [];
    for (const value of values) {
      await routeWebRpcRequest(value, {
        consentBackend: backend(),
        send: () => {},
        forward: (raw) => forwarded.push(raw),
      });
    }
    expect(forwarded).toEqual(values);
  });
});
