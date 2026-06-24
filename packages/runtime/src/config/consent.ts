// @summary Resolve/patch AI-data consent state (OVDR-11475 §3.A) between stored config and protocol shape

import { CONSENT_NOTICE_VERSION, type ConsentSetParams, type ConsentState } from "../protocol/index";
import type { DiligentConfig } from "./schema";

type StoredConsent = NonNullable<DiligentConfig["consent"]>;

/** Consent toggle default: service improvement ON (opt-out). */
export const DEFAULT_SERVICE_IMPROVEMENT = true;

/**
 * Placeholder privacy-policy URL surfaced to clients until the real URL is wired in.
 * TODO(OVDR-11475): replace with the deployed privacy-policy URL (or set `consent.privacyPolicyUrl` in config).
 */
export const DEFAULT_PRIVACY_POLICY_URL = "https://overdare.com/privacy";

/** Map stored config consent → resolved ConsentState exposed over the protocol. */
export function resolveConsentState(stored: StoredConsent | undefined): ConsentState {
  return {
    noticeAcknowledged: stored?.noticeAcknowledgedVersion === CONSENT_NOTICE_VERSION,
    serviceImprovement: stored?.serviceImprovement ?? DEFAULT_SERVICE_IMPROVEMENT,
    privacyPolicyUrl: stored?.privacyPolicyUrl ?? DEFAULT_PRIVACY_POLICY_URL,
  };
}

/**
 * Merge a consent/set patch into the stored consent subtree. `noticeAcknowledged: true`
 * stamps the current notice version; toggles are persisted explicitly. `now` is the
 * timestamp to record (injected for testability).
 */
export function applyConsentPatch(
  current: StoredConsent | undefined,
  patch: ConsentSetParams,
  now: string,
): StoredConsent {
  const next: StoredConsent = { ...current };
  if (patch.noticeAcknowledged !== undefined) {
    next.noticeAcknowledgedVersion = patch.noticeAcknowledged ? CONSENT_NOTICE_VERSION : undefined;
  }
  if (patch.serviceImprovement !== undefined) {
    next.serviceImprovement = patch.serviceImprovement;
  }
  next.updatedAt = now;
  return next;
}
