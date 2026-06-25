// @summary Tests for AI-data consent resolver/patch (OVDR-11475 §3.A)
import { afterEach, describe, expect, it, mock } from "bun:test";
import { CONSENT_NOTICE_VERSION } from "@diligent/protocol";

import {
  applyConsentPatch,
  PRIVACY_POLICY_BASE_URL,
  refreshPrivacyPolicyUrl,
  resetPrivacyPolicyUrlCache,
  resolveConsentState,
} from "../../src/config/consent";

const NOW = "2026-06-23T00:00:00.000Z";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetPrivacyPolicyUrlCache();
});

describe("resolveConsentState", () => {
  it("applies defaults when no consent is stored (service-improvement ON, notice not acknowledged)", () => {
    expect(resolveConsentState(undefined)).toEqual({
      noticeAcknowledged: false,
      serviceImprovement: true,
      privacyPolicyUrl: PRIVACY_POLICY_BASE_URL,
    });
  });

  it("treats the notice as acknowledged only when the stored version matches the current notice version", () => {
    expect(resolveConsentState({ noticeAcknowledgedVersion: CONSENT_NOTICE_VERSION }).noticeAcknowledged).toBe(true);
    expect(resolveConsentState({ noticeAcknowledgedVersion: "stale-version" }).noticeAcknowledged).toBe(false);
  });

  it("honours a stored toggle value and a custom privacy-policy URL", () => {
    expect(
      resolveConsentState({
        serviceImprovement: false,
        privacyPolicyUrl: "https://example.com/privacy",
      }),
    ).toEqual({
      noticeAcknowledged: false,
      serviceImprovement: false,
      privacyPolicyUrl: "https://example.com/privacy",
    });
  });
});

describe("applyConsentPatch", () => {
  it("stamps the current notice version when acknowledged and records updatedAt", () => {
    const next = applyConsentPatch(undefined, { noticeAcknowledged: true }, NOW);
    expect(next.noticeAcknowledgedVersion).toBe(CONSENT_NOTICE_VERSION);
    expect(next.updatedAt).toBe(NOW);
    expect(resolveConsentState(next).noticeAcknowledged).toBe(true);
  });

  it("clears the acknowledged version when noticeAcknowledged is set to false", () => {
    const next = applyConsentPatch(
      { noticeAcknowledgedVersion: CONSENT_NOTICE_VERSION },
      { noticeAcknowledged: false },
      NOW,
    );
    expect(next.noticeAcknowledgedVersion).toBeUndefined();
  });

  it("merges a toggle change without clobbering untouched fields", () => {
    const next = applyConsentPatch(
      { noticeAcknowledgedVersion: CONSENT_NOTICE_VERSION },
      { serviceImprovement: false },
      NOW,
    );
    expect(next).toMatchObject({
      noticeAcknowledgedVersion: CONSENT_NOTICE_VERSION,
      serviceImprovement: false,
      updatedAt: NOW,
    });
  });
});

describe("refreshPrivacyPolicyUrl", () => {
  it("builds a versioned URL from the latest-version manifest", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ latestVersion: "2026-01-12" }), { status: 200 }),
    ) as unknown as typeof fetch;

    expect(await refreshPrivacyPolicyUrl()).toBe(`${PRIVACY_POLICY_BASE_URL}?version=2026-01-12`);
    // Once resolved it feeds the synchronous consent state too.
    expect(resolveConsentState(undefined).privacyPolicyUrl).toBe(`${PRIVACY_POLICY_BASE_URL}?version=2026-01-12`);
  });

  it("falls back to the base URL when the manifest can't be fetched", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    expect(await refreshPrivacyPolicyUrl()).toBe(PRIVACY_POLICY_BASE_URL);
  });
});
