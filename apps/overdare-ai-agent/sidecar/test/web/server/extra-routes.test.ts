// @summary Tests the extraRoutes hook the OVERDARE MCP router endpoint mounts through (P071):
// product routes are reachable, and none of the server's own routes are shadowed by them.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer } from "../../../src/web/server/index";
import { WEB_IMAGE_ROUTE_PREFIX } from "../../../src/web/shared/image-routes";

describe("Web server extraRoutes hook", () => {
  let projectRoot = "";
  let stopServer: (() => void) | null = null;
  let baseUrl = "";
  let seen: string[] = [];

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "diligent-web-extra-routes-"));
    await Bun.write(join(projectRoot, ".diligent", "config.json"), JSON.stringify({ model: null }));
    seen = [];

    const { server, stop } = await createWebServer({
      cwd: projectRoot,
      port: 0,
      dev: true,
      extraRoutes: {
        matches: (url) => url.pathname.startsWith("/mcp-router"),
        handle: async (req, url) => {
          seen.push(`${req.method} ${url.pathname}`);
          return Response.json({ handled: url.pathname });
        },
      },
    });
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

  test("routes matching the hook reach it, including async handlers", async () => {
    const response = await fetch(`${baseUrl}/mcp-router/catalog`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handled: "/mcp-router/catalog" });
    expect(seen).toEqual(["GET /mcp-router/catalog"]);
  });

  test("the request method and body reach the hook intact", async () => {
    const response = await fetch(`${baseUrl}/mcp-router/tools/call`, {
      method: "POST",
      body: JSON.stringify({ tool: "echo" }),
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual(["POST /mcp-router/tools/call"]);
  });

  test("/health is never shadowed", async () => {
    // The hook is consulted after the server's own routes precisely so a product prefix cannot
    // capture the launcher's health check.
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen).toEqual([]);
  });

  test("persisted image routes are never shadowed", async () => {
    const response = await fetch(`${baseUrl}${WEB_IMAGE_ROUTE_PREFIX}thread-1/missing.png`);
    expect(response.status).toBe(404);
    expect(seen).toEqual([]);
  });

  test("unmatched paths fall through to the server's own handling", async () => {
    const response = await fetch(`${baseUrl}/anything-else`);
    // --dev mode answers 200 with its "start Vite separately" notice.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("--dev mode");
    expect(seen).toEqual([]);
  });

  test("a server built without the hook keeps its previous behavior", async () => {
    const other = await mkdtemp(join(tmpdir(), "diligent-web-no-hook-"));
    await Bun.write(join(other, ".diligent", "config.json"), JSON.stringify({ model: null }));
    const { server, stop } = await createWebServer({ cwd: other, port: 0, dev: true });
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(health.status).toBe(200);
      const router = await fetch(`http://127.0.0.1:${server.port}/mcp-router/catalog`);
      expect(router.status).toBe(200);
      expect(await router.text()).toContain("--dev mode");
    } finally {
      stop();
      await rm(other, { recursive: true, force: true });
    }
  });
});
