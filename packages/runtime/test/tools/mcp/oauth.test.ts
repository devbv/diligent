// @summary Tests for MCP OAuth helpers — header precedence, gating, and file token store

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpOAuthHandle, FileOAuthStore, resolveAuthHeaders, shouldUseOAuth } from "../../../src/tools/mcp/oauth";
import type { McpHttpServerConfig } from "../../../src/tools/mcp/types";

describe("resolveAuthHeaders", () => {
  test("keeps explicit Authorization header", () => {
    const config: McpHttpServerConfig = { url: "https://x", headers: { Authorization: "Bearer static" } };
    expect(resolveAuthHeaders(config).Authorization).toBe("Bearer static");
  });

  test("injects bearer token from env when no header is set", () => {
    process.env.__MCP_TEST_TOKEN = "abc";
    const config: McpHttpServerConfig = { url: "https://x", bearerTokenEnvVar: "__MCP_TEST_TOKEN" };
    expect(resolveAuthHeaders(config).Authorization).toBe("Bearer abc");
    delete process.env.__MCP_TEST_TOKEN;
  });

  test("explicit header wins over env bearer token", () => {
    process.env.__MCP_TEST_TOKEN = "abc";
    const config: McpHttpServerConfig = {
      url: "https://x",
      headers: { authorization: "Bearer explicit" },
      bearerTokenEnvVar: "__MCP_TEST_TOKEN",
    };
    expect(resolveAuthHeaders(config).authorization).toBe("Bearer explicit");
    expect(resolveAuthHeaders(config).Authorization).toBeUndefined();
    delete process.env.__MCP_TEST_TOKEN;
  });
});

describe("shouldUseOAuth", () => {
  test("false when an Authorization header is present", () => {
    expect(shouldUseOAuth({ url: "https://x", headers: { Authorization: "Bearer s" } })).toBe(false);
  });

  test("false when oauth is explicitly disabled", () => {
    expect(shouldUseOAuth({ url: "https://x", oauth: { enabled: false } })).toBe(false);
  });

  test("true for a plain remote server with no static auth", () => {
    expect(shouldUseOAuth({ url: "https://x" })).toBe(true);
  });
});

describe("FileOAuthStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-oauth-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("round-trips tokens, client info, and code verifier via patch", async () => {
    const store = new FileOAuthStore(join(dir, "srv.json"));
    expect(await store.getTokens()).toBeUndefined();
    await store.patch({ codeVerifier: "verifier" });
    await store.patch({ tokens: { access_token: "at", token_type: "Bearer" } });
    expect(await store.getCodeVerifier()).toBe("verifier");
    expect((await store.getTokens())?.access_token).toBe("at");
  });
});

describe("createMcpOAuthHandle", () => {
  test("provides SDK-compatible client metadata and a loopback redirect", () => {
    const handle = createMcpOAuthHandle(
      "srv",
      { storeDir: "/tmp/none", openBrowser: () => {}, redirectPort: 9999 },
      undefined,
    );
    expect(handle.provider.redirectUrl).toBe("http://127.0.0.1:9999/callback");
    expect(handle.provider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:9999/callback"]);
    handle.close();
  });

  test("waitForCallback rejects on timeout", async () => {
    const handle = createMcpOAuthHandle(
      "srv",
      { storeDir: "/tmp/none", openBrowser: () => {}, redirectPort: 9998 },
      undefined,
    );
    await expect(handle.waitForCallback(10)).rejects.toThrow(/timed out/);
    handle.close();
  });
});
