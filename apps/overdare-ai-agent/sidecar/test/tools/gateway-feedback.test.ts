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
        report_id: "report-789",
        reported_at: "2026-07-24T08:00:00.000Z",
      },
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const receipt = await postUserFeedback({
    accountId: "account-123",
    sessionId: "session-456",
    messageId: "item:assistant-1:7",
    category: "wrong_result",
    description: "The generated place could not be opened.",
    occurredAt: "2026-07-24T07:59:00.000Z",
    os: "Darwin",
    osVersion: "25.5.0",
    agentVersion: "0.8.0",
    cpu: "Apple M4",
    ram: "34359738368",
    projectId: "project-789",
    agentModel: "openai/gpt-5",
    locale: "ko-KR",
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
    category: "wrong_result",
    description: "The generated place could not be opened.",
    account_id: "account-123",
    session_id: "session-456",
    message_id: "item:assistant-1:7",
    occurred_at: "2026-07-24T07:59:00.000Z",
    os: "Darwin",
    os_version: "25.5.0",
    agent_version: "0.8.0",
    cpu: "Apple M4",
    ram: "34359738368",
    project_id: "project-789",
    agent_model: "openai/gpt-5",
    locale: "ko-KR",
  });
  expect(calls[0]?.body).not.toHaveProperty("message");
  expect(calls[0]?.body).not.toHaveProperty("preview");
});

test("rejects the report when the gateway does not accept it", async () => {
  globalThis.fetch = mock(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;

  await expect(
    postUserFeedback({
      accountId: "account-123",
      sessionId: "session-456",
      category: "etc",
      occurredAt: "2026-07-24T08:00:00.000Z",
      os: "Darwin",
      osVersion: "25.5.0",
    }),
  ).rejects.toThrow("Feedback report failed with HTTP 503");
});
