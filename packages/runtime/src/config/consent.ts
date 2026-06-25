// @summary Resolve/patch AI-data consent state (OVDR-11475 §3.A) between stored config and protocol shape

import { CONSENT_NOTICE_VERSION, type ConsentSetParams, type ConsentState } from "../protocol/index";
import type { DiligentConfig } from "./schema";

type StoredConsent = NonNullable<DiligentConfig["consent"]>;

/** Consent toggle default: service improvement ON (opt-out). */
export const DEFAULT_SERVICE_IMPROVEMENT = true;

/** Base privacy-policy URL; `?version=<latestVersion>` is appended once resolved. */
export const PRIVACY_POLICY_BASE_URL = "https://www.overdare.com/legal/privacy";
/** Manifest listing privacy-policy versions; `latestVersion` drives the surfaced URL. */
export const PRIVACY_POLICY_LATEST_URL = "https://static.overdare.com/legal/privacy/en/latest.json";

let cachedPrivacyPolicyUrl: string | undefined;

/**
 * Resolve the privacy-policy URL by reading {@link PRIVACY_POLICY_LATEST_URL} for `latestVersion`
 * and building `<base>?version=<latestVersion>`. Cached after the first success; bounded by a 3s
 * timeout and falls back to the base URL (uncached → retried) on any failure. Awaited from
 * `getInitializeResult` so clients receive the versioned URL.
 */
export async function refreshPrivacyPolicyUrl(): Promise<string> {
  if (cachedPrivacyPolicyUrl) return cachedPrivacyPolicyUrl;
  try {
    const res = await fetch(PRIVACY_POLICY_LATEST_URL, { signal: AbortSignal.timeout(3000) });
    const data = res.ok ? ((await res.json()) as { latestVersion?: unknown }) : undefined;
    if (data && typeof data.latestVersion === "string" && data.latestVersion) {
      cachedPrivacyPolicyUrl = `${PRIVACY_POLICY_BASE_URL}?version=${encodeURIComponent(data.latestVersion)}`;
    }
  } catch {
    // Network/timeout/parse failure — leave uncached so the next call retries.
  }
  return cachedPrivacyPolicyUrl ?? PRIVACY_POLICY_BASE_URL;
}

/** Best-known privacy-policy URL (cached versioned URL, else the base). Synchronous. */
export function currentPrivacyPolicyUrl(): string {
  return cachedPrivacyPolicyUrl ?? PRIVACY_POLICY_BASE_URL;
}

/** Test-only: clear the cached privacy-policy URL so tests stay order-independent. */
export function resetPrivacyPolicyUrlCache(): void {
  cachedPrivacyPolicyUrl = undefined;
}

/** Map stored config consent → resolved ConsentState exposed over the protocol. */
export function resolveConsentState(stored: StoredConsent | undefined): ConsentState {
  return {
    noticeAcknowledged: stored?.noticeAcknowledgedVersion === CONSENT_NOTICE_VERSION,
    serviceImprovement: stored?.serviceImprovement ?? DEFAULT_SERVICE_IMPROVEMENT,
    privacyPolicyUrl: stored?.privacyPolicyUrl ?? currentPrivacyPolicyUrl(),
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
