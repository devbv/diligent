// @summary Verifies UI-only sidecar mode disables the gateway consent service and record transmission.

import { describe, expect, test } from "bun:test";
import { createConsentMode } from "../src/server";
import type { ConsentService } from "../src/tools/gateway/consent";

function createConsentService(isGranted = false): ConsentService {
  return {
    get: () => ({
      noticeAcknowledged: false,
      serviceImprovement: isGranted,
      privacyPolicyUrl: "https://example.test/privacy",
    }),
    refresh: async () => {},
    set: () => ({
      noticeAcknowledged: false,
      serviceImprovement: isGranted,
      privacyPolicyUrl: "https://example.test/privacy",
    }),
    isGranted: () => isGranted,
  };
}

describe("sidecar consent mode", () => {
  test("does not create a gateway consent service or transmit records when Studio is disabled", () => {
    let factoryCalls = 0;
    const consentMode = createConsentMode(true, () => {
      factoryCalls += 1;
      return createConsentService(true);
    });

    expect(factoryCalls).toBe(0);
    expect(consentMode.consentBackend).toBeUndefined();
    expect(consentMode.canTransmitRecords()).toBe(false);
  });

  test("uses gateway consent outside UI-only mode", () => {
    const consentMode = createConsentMode(false, () => createConsentService(true));

    expect(consentMode.consentBackend).toBeDefined();
    expect(consentMode.canTransmitRecords()).toBe(true);
  });
});
