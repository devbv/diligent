// @summary Tests explicit user feedback submission to the OVERDARE gateway

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { postUserFeedback } from "../../src/tools/gateway/feedback";

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

test("posts authenticated user feedback with server-attested account and session correlation", async () => {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return Response.json(
      {
        status: "accepted",
        account_id: "account-123",
        session_id: "session-456",
        reported_at: "2026-07-24T08:00:00.000Z",
      },
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  await postUserFeedback({
    accountId: "account-123",
    sessionId: "session-456",
    feedback: "The generated place could not be opened.",
    source: "overdare-ai-agent",
    version: "dev-v0.8.0",
    projectId: "project-789",
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("http://127.0.0.1:8000/v1/reports");
  expect(calls[0]?.headers.get("Content-Type")).toBe("application/json");
  expect(calls[0]?.headers.get("Authorization")).toBe("Bearer feedback-token");
  expect(calls[0]?.body).toEqual({
    account_id: "account-123",
    session_id: "session-456",
    message: "The generated place could not be opened.",
    context: {
      source: "overdare-ai-agent",
      version: "dev-v0.8.0",
      projectId: "project-789",
      category: "user_feedback",
      submittedByUser: true,
    },
  });
});

test("rejects the report when the gateway does not accept it", async () => {
  globalThis.fetch = mock(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;

  await expect(
    postUserFeedback({
      accountId: "account-123",
      sessionId: "session-456",
      feedback: "Please investigate.",
      source: "overdare-ai-agent",
    }),
  ).rejects.toThrow("Feedback report failed with HTTP 503");
});
