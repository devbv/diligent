// @summary Tests for AI-data consent resolver/patch (OVDR-11475 §3.A)
import { describe, expect, it } from "bun:test";
import { CONSENT_NOTICE_VERSION } from "@diligent/protocol";

import { applyConsentPatch, DEFAULT_PRIVACY_POLICY_URL, resolveConsentState } from "../../src/config/consent";

const NOW = "2026-06-23T00:00:00.000Z";

describe("resolveConsentState", () => {
  it("applies defaults when no consent is stored (service-improvement ON, notice not acknowledged)", () => {
    expect(resolveConsentState(undefined)).toEqual({
      noticeAcknowledged: false,
      serviceImprovement: true,
      privacyPolicyUrl: DEFAULT_PRIVACY_POLICY_URL,
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
