// @summary Tests for web app branding config fallback and uppercase label derivation

import { expect, test } from "bun:test";

test("app branding defaults to Diligent when env is unset", async () => {
  const module = await import(`../../../../src/web/client/lib/app-config.ts?case=default-${Date.now()}`);

  expect(module.APP_PROJECT_NAME).toBe("Diligent");
  expect(module.APP_PROJECT_MARK).toBe("DILIGENT");
});

test("app branding respects VITE_APP_PROJECT_NAME", async () => {
  const previous = process.env.VITE_APP_PROJECT_NAME;
  process.env.VITE_APP_PROJECT_NAME = "Acme Agent";

  try {
    const module = await import(`../../../../src/web/client/lib/app-config.ts?case=custom-${Date.now()}`);
    expect(module.APP_PROJECT_NAME).toBe("Acme Agent");
    expect(module.APP_PROJECT_MARK).toBe("ACME AGENT");
  } finally {
    if (previous === undefined) delete process.env.VITE_APP_PROJECT_NAME;
    else process.env.VITE_APP_PROJECT_NAME = previous;
  }
});
