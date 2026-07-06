// @summary Tests unauthenticated OVERDARE gateway system-error forwarding.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  enqueueSystemErrorFromConsole,
  installConsoleSystemErrorForwarder,
  postSystemErrorFromConsole,
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
      component: "sidecar/server",
      version: "1.4.2",
      projectId: "proj-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:8000/v1/system-errors");
    expect(calls[0].authorization).toBeUndefined();
    expect(calls[0].body.source).toBe("overdare-ai-agent");
    expect(calls[0].body.severity).toBe("error");
    expect(calls[0].body.message).toBe("[Studio Server] failed to connect upstream");
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

    expect(calls[0].url).toBe("http://diligent-gateway-prod.ovdr.io/v1/system-errors");
  });

  test("uses the provided severity", async () => {
    const calls = installFetchSpy();

    await postSystemErrorFromConsole(["heads up"], { source: "overdare-ai-agent" }, "warning");

    expect(calls[0].body.severity).toBe("warning");
  });
});

describe("enqueueSystemErrorFromConsole", () => {
  test("defers fetch work off the caller stack", async () => {
    const calls = installFetchSpy();

    enqueueSystemErrorFromConsole(["boom"], { source: "overdare-ai-agent" });

    expect(calls).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:8000/v1/system-errors");
  });
});

describe("installConsoleSystemErrorForwarder", () => {
  test("keeps console output and maps levels to severities", async () => {
    const calls = installFetchSpy();
    const printed: Array<[string, unknown[]]> = [];
    console.log = (...args: unknown[]) => printed.push(["log", args]);
    console.warn = (...args: unknown[]) => printed.push(["warn", args]);
    console.error = (...args: unknown[]) => printed.push(["error", args]);

    installConsoleSystemErrorForwarder({ source: "overdare-ai-agent" });

    console.log("ready");
    console.warn("careful");
    console.error("boom");

    expect(printed).toEqual([
      ["log", ["ready"]],
      ["warn", ["careful"]],
      ["error", ["boom"]],
    ]);
    expect(calls).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(calls.map((call) => call.body.severity)).toEqual(["info", "warning", "error"]);
    expect(calls.map((call) => call.body.message)).toEqual(["ready", "careful", "boom"]);
  });
});
