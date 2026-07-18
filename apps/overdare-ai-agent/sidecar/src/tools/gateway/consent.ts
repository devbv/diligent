// @summary OVERDARE gateway consent service and cached privacy-policy resolver
//
// Moves AI-data consent off local `config.jsonc` onto the gateway as the single source of truth:
//   - GET  /v1/consent          → own status: "granted" | "withdrawn" | "none"
//   - POST /v1/consent {granted} → grant, or withdraw + full deletion (hot rows + session_index +
//                                  archived S3 objects); response carries the deletion counts.
//
// Consent is opt-in: until the user accepts (status "granted") nothing is transmitted. Auth reuses
// the Creator Hub token (same as the records transmitter); user identity is derived server-side
// from the bearer token.

import { createLogger } from "@diligent/logging";
import type { ConsentSetParams, ConsentState, WebConsentBackend } from "@diligent/web/consent-protocol";
import { DEBUG, resolveEndpoint, resolveToken } from "./shared";

const GATEWAY_CONSENT_TIMEOUT_MS = 5_000;
const logger = createLogger({ scope: "sidecar/gateway", context: { component: "consent" } });

export const PRIVACY_POLICY_BASE_URL = "https://www.overdare.com/legal/privacy";
export const PRIVACY_POLICY_LATEST_URL = "https://static.overdare.com/legal/privacy/en/latest.json";
export const PRIVACY_POLICY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cachedPrivacyPolicyUrl: string | undefined;
let cachedPrivacyPolicyAt: number | undefined;

type ConsentStatus = "granted" | "withdrawn" | "none";

export interface ConsentService extends WebConsentBackend {
  refresh(): Promise<void>;
  set(params: ConsentSetParams): Promise<ConsentState>;
  isGranted(): boolean;
}

interface ConsentGetResponse {
  status?: unknown;
}

/** POST /v1/consent {granted:false} deletion summary. */
interface ConsentDeletionResult {
  deleted_sessions?: number;
  records?: number;
  s3_objects?: number;
}

function normalizeStatus(value: unknown): ConsentStatus {
  return value === "granted" || value === "withdrawn" || value === "none" ? value : "none";
}

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_CONSENT_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshPrivacyPolicyUrl(now = Date.now()): Promise<string> {
  if (
    cachedPrivacyPolicyUrl &&
    cachedPrivacyPolicyAt !== undefined &&
    now - cachedPrivacyPolicyAt < PRIVACY_POLICY_CACHE_TTL_MS
  ) {
    return cachedPrivacyPolicyUrl;
  }
  try {
    const response = await fetch(PRIVACY_POLICY_LATEST_URL, { signal: AbortSignal.timeout(3_000) });
    const data = response.ok ? ((await response.json()) as { latestVersion?: unknown }) : undefined;
    if (typeof data?.latestVersion === "string" && data.latestVersion) {
      cachedPrivacyPolicyUrl = `${PRIVACY_POLICY_BASE_URL}?version=${encodeURIComponent(data.latestVersion)}`;
      cachedPrivacyPolicyAt = now;
    }
  } catch {
    // Keep the last known URL and retry on the next refresh when no cached value exists.
  }
  return currentPrivacyPolicyUrl();
}

export function currentPrivacyPolicyUrl(): string {
  return cachedPrivacyPolicyUrl ?? PRIVACY_POLICY_BASE_URL;
}

export function resetPrivacyPolicyUrlCache(): void {
  cachedPrivacyPolicyUrl = undefined;
  cachedPrivacyPolicyAt = undefined;
}

/** GET /v1/consent → own consent status. Non-OK responses preserve the cached state. */
async function fetchConsentStatus(token: string): Promise<ConsentStatus> {
  const res = await fetchWithTimeout(`${resolveEndpoint()}/v1/consent`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Gateway consent GET failed: HTTP ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as ConsentGetResponse;
  return normalizeStatus(body.status);
}

/** POST /v1/consent {granted}. Withdrawal triggers full server-side deletion; returns its counts. */
async function postConsent(token: string, granted: boolean): Promise<ConsentDeletionResult> {
  const res = await fetchWithTimeout(`${resolveEndpoint()}/v1/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ granted }),
  });
  if (!res.ok) throw new Error(`Gateway consent POST failed: HTTP ${res.status}`);
  return (await res.json().catch(() => ({}))) as ConsentDeletionResult;
}

/** Map server consent status to the protocol ConsentState the UI consumes. */
function statusToState(status: ConsentStatus): ConsentState {
  return {
    noticeAcknowledged: status !== "none", // "none" → first-run notice still shows
    serviceImprovement: status === "granted", // gates transmission upstream in the runtime
    privacyPolicyUrl: currentPrivacyPolicyUrl(),
  };
}

/** Resolve a consent/set patch to a grant/withdraw decision (popup acknowledgement = grant). */
function patchToGranted(params: ConsentSetParams, current: ConsentStatus): boolean {
  if (params.serviceImprovement !== undefined) return params.serviceImprovement;
  if (params.noticeAcknowledged !== undefined) return params.noticeAcknowledged;
  return current === "granted";
}

/**
 * Consent manager backed by the gateway. The server owns the truth; `status` is an in-memory cache
 * refreshed at `initialize` (via `refresh`) and after each `set`. Without a resolvable Hub token the
 * gateway is unreachable, so the last-known status is preserved.
 */
export function createGatewayConsentService(): ConsentService {
  let status: ConsentStatus = "none";

  return {
    get: () => statusToState(status),
    isGranted: () => status === "granted",
    refresh: async () => {
      await refreshPrivacyPolicyUrl();
      const token = await resolveToken();
      if (!token) return;
      try {
        status = await fetchConsentStatus(token);
      } catch (err) {
        if (DEBUG) logger.warn("consent.refresh_failed", { message: "[gateway] consent refresh failed", error: err });
      }
    },
    set: async (params) => {
      const token = await resolveToken();
      if (!token) return statusToState(status); // can't reach the gateway — leave cache as-is
      const granted = patchToGranted(params, status);
      try {
        const result = await postConsent(token, granted);
        status = granted ? "granted" : "withdrawn";
        if (DEBUG) {
          logger.debug("consent.set", {
            message: `[gateway] consent set granted=${granted}`,
            fields: { granted, result },
          });
        }
      } catch (err) {
        if (DEBUG) logger.warn("consent.set_failed", { message: "[gateway] consent set failed", error: err });
      }
      return statusToState(status);
    },
  };
}
