// @summary Verifies the Overdare analytics plugin sends Bubo studio-log payloads.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHookInput } from "@diligent/plugin-sdk";
import { onStop } from "../src/index.ts";

interface RpcRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface MockRpcServer {
  host: string;
  port: number;
  requests: RpcRequest[];
  stop: () => Promise<void>;
}

function startMockRpcServer(token: string): Promise<MockRpcServer> {
  const requests: RpcRequest[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;

      const line = buffer.slice(0, newlineIndex);
      const request = JSON.parse(line) as RpcRequest;
      requests.push(request);
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { token } })}\n`);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Mock RPC server did not bind to a TCP port"));
        return;
      }
      resolve({
        host: "127.0.0.1",
        port: address.port,
        requests,
        stop: () => new Promise((stopResolve) => server.close(() => stopResolve())),
      });
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2_000) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createStopInput(): PluginHookInput {
  return {
    hook_event_name: "Stop",
    session_id: "session-1",
    transcript_path: "",
    cwd: "/workspace/TestWorld",
    user_id: "account-1",
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    },
    model: "test-model",
    provider: "test-provider",
    provider_plan_type: "pro",
  };
}

describe("plugin-analytics", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let server: MockRpcServer;
  let homeDir: string;
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];

  beforeEach(async () => {
    process.env = { ...originalEnv };
    process.env.DILIGENT_ANALYTICS_ALLOW_IN_TEST = "true";
    process.env.DILIGENT_STORAGE_NAMESPACE = "overdare";
    process.env.OVERDARE_PROJECT_ID = "project-123";

    homeDir = join(tmpdir(), `plugin-analytics-${process.pid}-${Date.now()}`);
    const configDir = join(homeDir, ".overdare");
    mkdirSync(configDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    writeFileSync(
      join(configDir, "overdare.jsonc"),
      JSON.stringify(
        {
          bubo: {
            endpoint: "https://bubo.test/studio-log",
          },
        },
        null,
        2,
      ),
    );

    server = await startMockRpcServer("hub-token-1");
    process.env.STUDIO_HOST = server.host;
    process.env.STUDIO_PORT = String(server.port);

    fetchCalls.length = 0;
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    await server.stop();
    rmSync(homeDir, { recursive: true, force: true });
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("onStop sends usage to Bubo /studio-log with Hub token auth", async () => {
    await onStop(createStopInput());
    await waitFor(() => fetchCalls.length === 1);

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ method: "hub.token.read" });

    const [call] = fetchCalls;
    expect(call.url).toBe("https://bubo.test/studio-log");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer hub-token-1",
    });

    const payload = JSON.parse(String(call.init.body));
    expect(payload).toMatchObject({
      account_id: "account-1",
      device: {
        gpu: "",
      },
      events: [
        {
          event_name: "agent_token_usage",
          values: {
            cwd: "TestWorld",
            session_id: "session-1",
            model: "test-model",
            provider: "test-provider",
            provider_plan_type: "pro",
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 3,
            cache_write_tokens: 4,
          },
        },
      ],
      studio_info: {
        group_id: "",
        project_id: "project-123",
        studio_version: "",
        world_id: "",
      },
      tags: {},
    });
    expect(payload.IP).toBeUndefined();
    expect(payload.Country).toBeUndefined();
    expect(payload.events[0].values.reqId).toBeUndefined();
    expect(payload.events[0].values.sessionId).toBeUndefined();
    expect(payload.events[0].values.inputTokens).toBeUndefined();
    expect(payload.events[0].values.outputTokens).toBeUndefined();
    expect(payload.events[0].values.cacheReadTokens).toBeUndefined();
    expect(payload.events[0].values.cacheWriteTokens).toBeUndefined();
    expect(typeof payload.events[0].ts).toBe("number");
    expect(typeof payload.device.os).toBe("string");
    expect(typeof payload.device.os_version).toBe("string");
    expect(typeof payload.device.platform).toBe("string");
    expect(typeof payload.device.cpu).toBe("string");
    expect(typeof payload.device.ram).toBe("string");
  });

  test.each([
    ["https://create.overdare.com", "https://bubo.overdare.com/studio-log"],
    ["https://release-qa.overdare.com", "https://bubo-staging.overdare.com/studio-log"],
    ["https://dev-create.overdare.com", "https://bubo-dev.ovdr.io/studio-log"],
  ])("maps HUB_DOMAIN %s to %s when endpoint is not configured", async (hubDomain, expectedEndpoint) => {
    writeFileSync(join(homeDir, ".overdare", "overdare.jsonc"), JSON.stringify({}));
    process.env.HUB_DOMAIN = hubDomain;
    fetchCalls.length = 0;

    const module = await import(`../src/index.ts?hubDomain=${encodeURIComponent(hubDomain)}-${Date.now()}`);
    await module.onStop(createStopInput());
    await waitFor(() => fetchCalls.length === 1);

    expect(fetchCalls[0].url).toBe(expectedEndpoint);
  });
});
