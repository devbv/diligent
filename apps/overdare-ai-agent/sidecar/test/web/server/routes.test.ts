// @summary Tests persisted image HTTP route serving and path hardening for the Web server
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer } from "../../../src/web/server/index";
import { WEB_IMAGE_ROUTE_PREFIX } from "../../../src/web/shared/image-routes";

describe("Web server persisted image route", () => {
  let projectRoot = "";
  let stopServer: (() => void) | null = null;
  let baseUrl = "";

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "diligent-web-server-"));
    const imageDir = join(projectRoot, ".diligent", "images", "thread-1");
    await mkdir(imageDir, { recursive: true });
    await Bun.write(join(imageDir, "shot 1.png"), "png-bytes");
    await Bun.write(join(projectRoot, ".diligent", "config.json"), JSON.stringify({ model: null }));

    const { server, stop } = await createWebServer({ cwd: projectRoot, port: 0, dev: true });
    stopServer = stop;
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    stopServer?.();
    stopServer = null;
    if (projectRoot) {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("serves persisted images with image headers", async () => {
    const response = await fetch(`${baseUrl}${WEB_IMAGE_ROUTE_PREFIX}thread-1/shot%201.png`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("png-bytes");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("rejects traversal attempts outside persisted image root", async () => {
    const response = await fetch(`${baseUrl}${WEB_IMAGE_ROUTE_PREFIX}..%2F..%2Fconfig.json`);
    expect(response.status).toBe(404);
  });

  test("returns 404 for missing persisted images", async () => {
    const response = await fetch(`${baseUrl}${WEB_IMAGE_ROUTE_PREFIX}thread-1/missing.png`);
    expect(response.status).toBe(404);
  });
});
