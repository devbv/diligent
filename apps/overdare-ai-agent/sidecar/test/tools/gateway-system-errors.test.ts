// @summary Tests unauthenticated OVERDARE gateway system-error forwarding.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createConsoleSink, createLogger, type LogRecord, resetDefaultLogSinkForTests } from "@diligent/logging";
import { configureSidecarLogging } from "../../src/logging";
import {
  createGatewaySystemLogSink,
  enqueueSystemErrorFromConsole,
  installConsoleSystemErrorForwarder,
  postStructuredSystemLog,
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
  resetDefaultLogSinkForTests();
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

describe("structured gateway system-log sink", () => {
  const options = {
    source: "overdare-ai-agent",
    userId: "user-1",
    version: "2.0.0",
    projectId: "project-1",
  };

  test("maps a LogRecord timestamp and preserves session correlation in the message", async () => {
    const calls = installFetchSpy();
    const record: LogRecord = {
      timestamp: "2026-07-14T05:00:00.123Z",
      level: "warn",
      scope: "llm/retry",
      component: "provider/openai",
      event: "retry.scheduled",
      message: "Retrying provider request",
      sessionId: "session-7",
      threadId: "thread-3",
      turnId: "turn-9",
      fields: { attempt: 2, delayMs: 500 },
    };

    await postStructuredSystemLog(record, options);

    expect(calls).toHaveLength(1);
    expect(calls[0].authorization).toBeUndefined();
    expect(calls[0].body).toMatchObject({
      source: "overdare-ai-agent",
      event_ts: "2026-07-14T05:00:00.123Z",
      severity: "warning",
      user_id: "user-1",
      component: "provider/openai",
      version: "2.0.0",
      project_id: "project-1",
      session_id: "session-7",
      context: {
        scope: "llm/retry",
        event: "retry.scheduled",
        threadId: "thread-3",
        turnId: "turn-9",
        fields: { attempt: 2, delayMs: 500 },
      },
    });
    expect(calls[0].body.message).not.toContain("timestamp=");
    expect(calls[0].body.message).toContain("sessionId=session-7");
    expect(calls[0].body.message).toContain("Retrying provider request");
    expect(calls[0].body.message).toContain("scope=llm/retry");
    expect(calls[0].body.message).toContain("event=retry.scheduled");
    expect(calls[0].body.message).toContain("attempt=2");
    expect(calls[0].body.message).toContain("delayMs=500");
  });

  test("uses scope as component and includes normalized error details", async () => {
    const calls = installFetchSpy();
    const record: LogRecord = {
      timestamp: "2026-07-14T05:00:00.123Z",
      level: "error",
      scope: "sidecar/server",
      event: "startup.failed",
      message: "Failed to start studio web server",
      error: { name: "TypeError", message: "bad port", stack: "TypeError: bad port\n  at server.ts:1" },
      fields: {},
    };

    await postStructuredSystemLog(record, options);

    expect(calls[0].body.component).toBe("sidecar/server");
    expect(calls[0].body.error_type).toBe("TypeError");
    expect(calls[0].body.stack).toContain("TypeError: bad port");
    expect(calls[0].body.fingerprint).toBe("TypeError:bad port");
  });

  test("filters debug and defers network work off the logging call stack", async () => {
    const calls = installFetchSpy();
    const sink = createGatewaySystemLogSink(options);
    const logger = createLogger({ scope: "sidecar/test", sink });

    logger.debug("hidden", "debug message");
    logger.info("ready", "ready message");

    expect(calls).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(calls).toHaveLength(1);
    expect(calls[0].body.message).toContain("sessionId=n/a ready message");
    expect(calls[0].body.message).toContain("scope=sidecar/test");
    expect(calls[0].body.message).toContain("event=ready");
  });

  test("startup configuration fans default logs out to console and gateway once", async () => {
    const calls = installFetchSpy();
    const printed: string[] = [];
    console.info = (...args: unknown[]) => printed.push(args.map(String).join(" "));
    configureSidecarLogging(options);

    createLogger({ scope: "sidecar/server" }).info("server.ready", "Server ready");

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("Server ready");
    expect(calls).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.event_ts).toEqual(expect.any(String));
    expect(calls[0].body.message).toContain("sessionId=n/a Server ready");
    expect(calls[0].body.message).toContain("scope=sidecar/server");
    expect(calls[0].body.message).toContain("event=server.ready");
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

  test("does not remotely forward console writes emitted by the structured console sink", async () => {
    const calls = installFetchSpy();
    const printed: string[] = [];
    console.info = (...args: unknown[]) => printed.push(args.map(String).join(" "));
    installConsoleSystemErrorForwarder({ source: "overdare-ai-agent" });
    const logger = createLogger({
      scope: "sidecar/server",
      sink: createConsoleSink(),
      clock: () => new Date("2026-07-14T05:00:00.123Z"),
    });

    logger.info("server.ready", "Studio server ready");

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("Studio server ready");
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(calls).toHaveLength(0);
  });
});
