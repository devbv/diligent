// @summary Tests OVERDARE bundled analytics hook provider behavior.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@diligent/runtime";
import { createStudioBundledToolProviders } from "../../src/tools";
import { onStop } from "../../src/tools/analytics";

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

function createStopInput(): HookInput {
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

describe("createAnalyticsToolProvider", () => {
  test("creates hook-only analytics provider with plugin supersession", async () => {
    const providers = createStudioBundledToolProviders({ cwd: "/tmp/project" });
    const provider = providers.find((candidate) => candidate.id === "@overdare/analytics-hooks");

    expect(provider).toBeDefined();
    expect(provider!.supersedesPluginPackages).toContain("@overdare/plugin-analytics");
    expect(provider!.onStop).toBeFunction();
    expect(await provider!.createTools({ cwd: "/tmp/project" })).toEqual([]);
  });
});

describe("analytics onStop", () => {
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

    homeDir = join(tmpdir(), `sidecar-analytics-${process.pid}-${Date.now()}`);
    const configDir = join(homeDir, ".overdare");
    mkdirSync(configDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    writeFileSync(
      join(configDir, "overdare.jsonc"),
      JSON.stringify({ bubo: { endpoint: "https://bubo.test/studio-log" } }, null, 2),
    );

    server = await startMockRpcServer("hub-token-1");
    process.env.STUDIO_HOST = server.host;
    process.env.STUDIO_PORT = String(server.port);

    fetchCalls.length = 0;
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    await server.stop();
    rmSync(homeDir, { recursive: true, force: true });
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("sends usage to Bubo /studio-log with Hub token auth", async () => {
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
        project_id: "project-123",
      },
    });
  });
});
