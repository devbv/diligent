// @summary Tests the Web-owned consent RPC contract

import { describe, expect, test } from "bun:test";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import { ConsentSetParamsSchema, ConsentStateSchema, WEB_CONSENT_SET_METHOD } from "../../src/shared/consent-protocol";

describe("Web consent protocol", () => {
  test("keeps the existing wire method while validating only Web-owned fields", () => {
    expect(WEB_CONSENT_SET_METHOD).toBe("consent/set");
    expect(Object.values(DILIGENT_CLIENT_REQUEST_METHODS)).not.toContain(WEB_CONSENT_SET_METHOD);
    expect(ConsentSetParamsSchema.parse({ serviceImprovement: false })).toEqual({ serviceImprovement: false });
    expect(ConsentSetParamsSchema.safeParse({ serviceImprovement: "yes" }).success).toBe(false);
  });

  test("requires a complete consent state from the backend", () => {
    expect(
      ConsentStateSchema.parse({
        noticeAcknowledged: true,
        serviceImprovement: false,
        privacyPolicyUrl: "https://example.test/privacy",
      }),
    ).toBeDefined();
    expect(ConsentStateSchema.safeParse({ noticeAcknowledged: true }).success).toBe(false);
  });
});
