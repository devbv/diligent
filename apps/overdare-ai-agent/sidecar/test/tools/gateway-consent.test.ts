// @summary Tests the OVERDARE gateway consent backend (OVDR-11475 §3.A, server-owned consent).

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createGatewayConsentBackend } from "../../src/tools/gateway/consent";

const realFetch = globalThis.fetch;
const realUrl = process.env.DILIGENT_GATEWAY_URL;
const realToken = process.env.DILIGENT_GATEWAY_TOKEN;

interface FetchCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
  authorization?: string;
}

/** Spy that replies to GET /v1/consent with `status` and echoes POST bodies. */
function installConsentSpy(getStatus: string): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    calls.push({
      url: String(input),
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.get("authorization") ?? undefined,
    });
    if (method === "GET") {
      return new Response(JSON.stringify({ status: getStatus }), { status: 200 });
    }
    return new Response(JSON.stringify({ deleted_sessions: 2, records: 9, s3_objects: 3 }), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  process.env.DILIGENT_GATEWAY_URL = "http://127.0.0.1:8000";
  process.env.DILIGENT_GATEWAY_TOKEN = "test-token"; // override → no Studio RPC needed
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realUrl === undefined) delete process.env.DILIGENT_GATEWAY_URL;
  else process.env.DILIGENT_GATEWAY_URL = realUrl;
  if (realToken === undefined) delete process.env.DILIGENT_GATEWAY_TOKEN;
  else process.env.DILIGENT_GATEWAY_TOKEN = realToken;
});

describe("createGatewayConsentBackend", () => {
  test("defaults to 'none' (notice unacknowledged, transmission off) before refresh", () => {
    installConsentSpy("granted");
    const backend = createGatewayConsentBackend();
    const state = backend.get();
    expect(state.noticeAcknowledged).toBe(false);
    expect(state.serviceImprovement).toBe(false);
  });

  test("refresh() syncs status from GET /v1/consent", async () => {
    const calls = installConsentSpy("granted");
    const backend = createGatewayConsentBackend();

    await backend.refresh?.();

    expect(calls[0].url).toBe("http://127.0.0.1:8000/v1/consent");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].authorization).toBe("Bearer test-token");
    expect(backend.get().serviceImprovement).toBe(true);
    expect(backend.get().noticeAcknowledged).toBe(true);
  });

  test("set({noticeAcknowledged:true}) POSTs granted:true (popup acceptance = consent)", async () => {
    const calls = installConsentSpy("none");
    const backend = createGatewayConsentBackend();

    const state = await backend.set({ noticeAcknowledged: true });

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("http://127.0.0.1:8000/v1/consent");
    expect(post?.body).toEqual({ granted: true });
    expect(state.serviceImprovement).toBe(true);
  });

  test("set({serviceImprovement:false}) POSTs granted:false (withdrawal)", async () => {
    const calls = installConsentSpy("granted");
    const backend = createGatewayConsentBackend();

    const state = await backend.set({ serviceImprovement: false });

    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ granted: false });
    expect(state.serviceImprovement).toBe(false);
    expect(state.noticeAcknowledged).toBe(true); // withdrawn, but notice still acknowledged
  });
});
