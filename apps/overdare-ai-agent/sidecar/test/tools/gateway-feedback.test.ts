// @summary Tests explicit user feedback submission to the OVERDARE gateway

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { FeedbackGatewayError, postUserFeedback } from "../../src/tools/gateway/feedback";

const realFetch = globalThis.fetch;
const realUrl = process.env.DILIGENT_GATEWAY_URL;
const realToken = process.env.DILIGENT_GATEWAY_TOKEN;

beforeEach(() => {
  process.env.DILIGENT_GATEWAY_URL = "http://127.0.0.1:8000";
  process.env.DILIGENT_GATEWAY_TOKEN = "feedback-token";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realUrl === undefined) delete process.env.DILIGENT_GATEWAY_URL;
  else process.env.DILIGENT_GATEWAY_URL = realUrl;
  if (realToken === undefined) delete process.env.DILIGENT_GATEWAY_TOKEN;
  else process.env.DILIGENT_GATEWAY_TOKEN = realToken;
});

test("posts the authenticated, reduced report payload and maps the receipt", async () => {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return Response.json(
      {
        report_id: "report-789",
        reported_at: "2026-07-24T08:00:00.000Z",
      },
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const receipt = await postUserFeedback({
    clientReportId: "1cf50de8-8232-4bc9-8841-9f36b85ba86f",
    sessionId: "session-456",
    messageId: "persistent-message-id",
    category: "error",
    description: "The generated place could not be opened.",
  });

  expect(receipt).toEqual({
    reportId: "report-789",
    reportedAt: "2026-07-24T08:00:00.000Z",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("http://127.0.0.1:8000/v1/reports");
  expect(calls[0]?.headers.get("Content-Type")).toBe("application/json");
  expect(calls[0]?.headers.get("Authorization")).toBe("Bearer feedback-token");
  expect(calls[0]?.body).toEqual({
    client_report_id: "1cf50de8-8232-4bc9-8841-9f36b85ba86f",
    category: "error",
    description: "The generated place could not be opened.",
    session_id: "session-456",
    message_id: "persistent-message-id",
  });
  expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual([
    "category",
    "client_report_id",
    "description",
    "message_id",
    "session_id",
  ]);
});

test.each([429, 503])("preserves HTTP %i as structured gateway error data", async (status) => {
  globalThis.fetch = mock(async () => new Response("unavailable", { status })) as unknown as typeof fetch;

  try {
    await postUserFeedback({
      clientReportId: "1cf50de8-8232-4bc9-8841-9f36b85ba86f",
      sessionId: "session-456",
      messageId: "persistent-message-id",
      category: "etc",
    });
    expect.unreachable("Expected the gateway request to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(FeedbackGatewayError);
    expect((error as FeedbackGatewayError).data).toEqual({ httpStatus: status });
  }
});
