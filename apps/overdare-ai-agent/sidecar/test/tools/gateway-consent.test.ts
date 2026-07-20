// @summary Tests the OVERDARE gateway consent backend (OVDR-11475 §3.A, server-owned consent).

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  createGatewayConsentService,
  PRIVACY_POLICY_BASE_URL,
  PRIVACY_POLICY_CACHE_TTL_MS,
  refreshPrivacyPolicyUrl,
  resetPrivacyPolicyUrlCache,
} from "../../src/tools/gateway/consent";

const realFetch = globalThis.fetch;
const realUrl = process.env.DILIGENT_GATEWAY_URL;
const realToken = process.env.DILIGENT_GATEWAY_TOKEN;

interface FetchCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
  authorization?: string;
  signal?: AbortSignal;
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
      signal: init?.signal ?? undefined,
    });
    if (method === "GET") {
      return new Response(JSON.stringify({ status: getStatus }), { status: 200 });
    }
    return new Response(JSON.stringify({ deleted_sessions: 2, records: 9, s3_objects: 3 }), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  resetPrivacyPolicyUrlCache();
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

describe("createGatewayConsentService", () => {
  test("defaults to 'none' (notice unacknowledged, transmission off) before refresh", () => {
    installConsentSpy("granted");
    const backend = createGatewayConsentService();
    const state = backend.get();
    expect(state.noticeAcknowledged).toBe(false);
    expect(state.serviceImprovement).toBe(false);
    expect(backend.isGranted()).toBe(false);
  });

  test("refresh() syncs status from GET /v1/consent", async () => {
    const calls = installConsentSpy("granted");
    const backend = createGatewayConsentService();

    await backend.refresh?.();

    const consentGet = calls.find((call) => call.url.endsWith("/v1/consent"));
    expect(consentGet?.url).toBe("http://127.0.0.1:8000/v1/consent");
    expect(consentGet?.method).toBe("GET");
    expect(consentGet?.authorization).toBe("Bearer test-token");
    expect(consentGet?.signal).toBeInstanceOf(AbortSignal);
    expect(backend.get().serviceImprovement).toBe(true);
    expect(backend.get().noticeAcknowledged).toBe(true);
    expect(backend.isGranted()).toBe(true);
  });

  test("set({noticeAcknowledged:true}) POSTs granted:true (popup acceptance = consent)", async () => {
    const calls = installConsentSpy("none");
    const backend = createGatewayConsentService();

    const state = await backend.set({ noticeAcknowledged: true });

    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("http://127.0.0.1:8000/v1/consent");
    expect(post?.body).toEqual({ granted: true });
    expect(post?.signal).toBeInstanceOf(AbortSignal);
    expect(state.serviceImprovement).toBe(true);
  });

  test("set({serviceImprovement:false}) POSTs granted:false (withdrawal)", async () => {
    const calls = installConsentSpy("granted");
    const backend = createGatewayConsentService();

    const state = await backend.set({ serviceImprovement: false });

    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ granted: false });
    expect(state.serviceImprovement).toBe(false);
    expect(state.noticeAcknowledged).toBe(true); // withdrawn, but notice still acknowledged
    expect(backend.isGranted()).toBe(false);
  });

  test("refresh() preserves current state when gateway fails", async () => {
    installConsentSpy("granted");
    const backend = createGatewayConsentService();
    await backend.refresh?.();
    expect(backend.get().serviceImprovement).toBe(true);

    globalThis.fetch = mock(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    await backend.refresh?.();

    expect(backend.get().serviceImprovement).toBe(true);
    expect(backend.get().noticeAcknowledged).toBe(true);
  });

  test("set() preserves current state when gateway fails", async () => {
    installConsentSpy("granted");
    const backend = createGatewayConsentService();
    await backend.refresh?.();
    expect(backend.get().serviceImprovement).toBe(true);

    globalThis.fetch = mock(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    const state = await backend.set({ serviceImprovement: false });

    expect(state.serviceImprovement).toBe(true);
    expect(state.noticeAcknowledged).toBe(true);
  });
});

describe("privacy-policy URL", () => {
  test("resolves a versioned URL from the bounded manifest request", async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      signal = init?.signal;
      return new Response(JSON.stringify({ latestVersion: "2026-01-12" }), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await refreshPrivacyPolicyUrl()).toBe(`${PRIVACY_POLICY_BASE_URL}?version=2026-01-12`);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("falls back to the base URL when the manifest is unavailable", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    expect(await refreshPrivacyPolicyUrl()).toBe(PRIVACY_POLICY_BASE_URL);
  });

  test("caches within the TTL and refreshes after expiry", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ latestVersion: `2026-01-${fetchCount}` }), { status: 200 });
    }) as unknown as typeof fetch;

    const start = Date.now();
    await refreshPrivacyPolicyUrl(start);
    await refreshPrivacyPolicyUrl(start + PRIVACY_POLICY_CACHE_TTL_MS - 1);
    expect(fetchCount).toBe(1);
    expect(await refreshPrivacyPolicyUrl(start + PRIVACY_POLICY_CACHE_TTL_MS)).toBe(
      `${PRIVACY_POLICY_BASE_URL}?version=2026-01-2`,
    );
    expect(fetchCount).toBe(2);
  });
});
