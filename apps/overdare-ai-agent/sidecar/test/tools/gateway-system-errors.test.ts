// @summary Tests unauthenticated OVERDARE gateway system-error forwarding.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  enqueueSystemErrorFromConsole,
  installConsoleSystemErrorForwarder,
  postSystemErrorFromConsole,
  resetConsoleSystemErrorForwarderForTests,
} from "../../src/tools/gateway/system-errors";

const realFetch = globalThis.fetch;
const realUrl = process.env.DILIGENT_GATEWAY_URL;
const realDiligentEnv = process.env.DILIGENT_ENV;
const realConsole = {
  debug: console.debug,
  error: console.error,
  info: console.info,
  log: console.log,
  warn: console.warn,
};

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
  authorization?: string;
}

function installFetchSpy(): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
      authorization: headers.get("authorization") ?? undefined,
    });
    return new Response(JSON.stringify({ accepted: 1, inserted: 1, duplicates: 0, skipped: 0 }), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  process.env.DILIGENT_GATEWAY_URL = "http://127.0.0.1:8000";
  delete process.env.DILIGENT_ENV;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetConsoleSystemErrorForwarderForTests();
  console.debug = realConsole.debug;
  console.error = realConsole.error;
  console.info = realConsole.info;
  console.log = realConsole.log;
  console.warn = realConsole.warn;
  if (realUrl === undefined) delete process.env.DILIGENT_GATEWAY_URL;
  else process.env.DILIGENT_GATEWAY_URL = realUrl;
  if (realDiligentEnv === undefined) delete process.env.DILIGENT_ENV;
  else process.env.DILIGENT_ENV = realDiligentEnv;
});

describe("postSystemErrorFromConsole", () => {
  test("POSTs one unauthenticated system error event", async () => {
    const calls = installFetchSpy();
    const error = new TypeError("failed to connect upstream");

    await postSystemErrorFromConsole(["[Studio Server]", error], {
      source: "overdare-ai-agent",
      userId: "user-abc-123",
      component: "sidecar/server",
      version: "1.4.2",
      projectId: "proj-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:8000/v1/system-logs");
    expect(calls[0].authorization).toBeUndefined();
    expect(calls[0].body.source).toBe("overdare-ai-agent");
    expect(calls[0].body.severity).toBe("error");
    expect(calls[0].body.message).toBe("[Studio Server] failed to connect upstream");
    expect(calls[0].body.user_id).toBe("user-abc-123");
    expect(calls[0].body.component).toBe("sidecar/server");
    expect(calls[0].body.version).toBe("1.4.2");
    expect(calls[0].body.project_id).toBe("proj-1");
    expect(calls[0].body.error_type).toBe("TypeError");
    expect(calls[0].body.stack).toContain("TypeError: failed to connect upstream");
    expect(calls[0].body.fingerprint).toBe("TypeError:failed to connect upstream");
  });

  test("uses the prod gateway host when DILIGENT_ENV is prod", async () => {
    delete process.env.DILIGENT_GATEWAY_URL;
    process.env.DILIGENT_ENV = "prod";
    const calls = installFetchSpy();

    await postSystemErrorFromConsole(["boom"], { source: "overdare-ai-agent" });

    expect(calls[0].url).toBe("https://diligent-gateway-prod.ovdr.io/v1/system-logs");
  });

  test("uses the provided severity", async () => {
    const calls = installFetchSpy();

    await postSystemErrorFromConsole(["heads up"], { source: "overdare-ai-agent" }, "warning");

    expect(calls[0].body.severity).toBe("warning");
  });

  test("omits user_id from the body when it is not provided", async () => {
    const calls = installFetchSpy();

    await postSystemErrorFromConsole(["boom"], { source: "overdare-ai-agent" });

    expect(calls[0].body).not.toHaveProperty("user_id");
  });

  test("strips llm retry timestamps from the forwarded remote message only", async () => {
    const calls = installFetchSpy();
    const retryLog = "[llm:retry] timestamp=2026-07-14T05:00:00.123Z sessionId=sess-123 provider=openai attempt=2";

    await postSystemErrorFromConsole([retryLog], { source: "overdare-ai-agent" });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.message).toBe("[llm:retry] sessionId=sess-123 provider=openai attempt=2");
    expect(calls[0].body.event_ts).toEqual(expect.any(String));
    expect(calls[0].body.event_ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("enqueueSystemErrorFromConsole", () => {
  test("defers fetch work off the caller stack", async () => {
    const calls = installFetchSpy();

    enqueueSystemErrorFromConsole(["boom"], { source: "overdare-ai-agent" });

    expect(calls).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:8000/v1/system-logs");
  });
});

describe("installConsoleSystemErrorForwarder", () => {
  test("keeps console output and maps levels to severities", async () => {
    const calls = installFetchSpy();
    const printed: Array<[string, unknown[]]> = [];
    console.log = (...args: unknown[]) => printed.push(["log", args]);
    console.info = (...args: unknown[]) => printed.push(["info", args]);
    console.debug = (...args: unknown[]) => printed.push(["debug", args]);
    console.warn = (...args: unknown[]) => printed.push(["warn", args]);
    console.error = (...args: unknown[]) => printed.push(["error", args]);

    installConsoleSystemErrorForwarder({ source: "overdare-ai-agent" });

    console.log("ready");
    console.info("started");
    console.debug("trace");
    console.warn("careful");
    console.error("boom");

    expect(printed).toEqual([
      ["log", ["ready"]],
      ["info", ["started"]],
      ["debug", ["trace"]],
      ["warn", ["careful"]],
      ["error", ["boom"]],
    ]);
    expect(calls).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(calls.map((call) => call.body.severity)).toEqual(["info", "info", "warning", "error"]);
    expect(calls.map((call) => call.body.message)).toEqual(["ready", "started", "careful", "boom"]);
  });

  test("preserves llm retry timestamps locally while omitting them from remote forwarding", async () => {
    const calls = installFetchSpy();
    const printed: Array<[string, unknown[]]> = [];
    console.info = (...args: unknown[]) => printed.push(["info", args]);

    installConsoleSystemErrorForwarder({ source: "overdare-ai-agent" });

    const retryLog = "[llm:retry] timestamp=2026-07-14T05:00:00.123Z sessionId=sess-123 provider=openai attempt=2";
    console.info(retryLog);

    expect(printed).toEqual([["info", [retryLog]]]);
    expect(calls).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(calls).toHaveLength(1);
    expect(calls[0].body.event_ts).toEqual(expect.any(String));
    expect(calls[0].body.message).toBe("[llm:retry] sessionId=sess-123 provider=openai attempt=2");
  });
});
