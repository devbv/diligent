// @summary Tests Vite dev proxy routes used by the web frontend during local development

import { expect, test } from "bun:test";
import type { ConfigEnv, UserConfig } from "vite";
import { WEB_IMAGE_ROUTE_PREFIX } from "../src/shared/image-routes";
import config from "../vite.config";

async function resolveViteConfig(): Promise<UserConfig> {
  const env: ConfigEnv = { command: "serve", mode: "development" };
  if (typeof config === "function") {
    return await config(env);
  }
  return await config;
}

test("dev server proxies persisted image route to the backend server", async () => {
  const resolved = await resolveViteConfig();
  const proxy = resolved.server?.proxy as Record<string, unknown> | undefined;

  expect(proxy?.[WEB_IMAGE_ROUTE_PREFIX]).toMatchObject({
    target: "http://localhost:7433",
  });
});
