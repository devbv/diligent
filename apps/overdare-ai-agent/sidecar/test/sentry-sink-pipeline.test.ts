// @summary Integration test: logger → default fanout sink → shared Sentry sink,
// the exact composition the browser client installs in web/client/sentry.ts.
import { afterEach, describe, expect, test } from "bun:test";
import {
  createConsoleSink,
  createFanoutSink,
  createLogger,
  resetDefaultLogSinkForTests,
  setDefaultLogSink,
} from "@diligent/logging";
import { createSentryLogSink, type SentryLogScope } from "../src/web/shared/sentry-config";

interface Captured {
  tags: Record<string, string>;
  fingerprint?: string[];
  level?: string;
  exception?: unknown;
  message?: string;
}

function fakeSentry(captured: Captured[]) {
  let current: Captured | null = null;
  const scope: SentryLogScope = {
    setTag: (key, value) => {
      if (current) current.tags[key] = value;
    },
    setFingerprint: (fingerprint) => {
      if (current) current.fingerprint = fingerprint;
    },
    setLevel: (level) => {
      if (current) current.level = level;
    },
  };
  return {
    getClient: () => ({}),
    withScope: (callback: (scope: SentryLogScope) => void) => {
      current = { tags: {} };
      callback(scope);
      current = null;
    },
    captureException: (exception: unknown) => {
      if (current) {
        current.exception = exception;
        captured.push(current);
      }
    },
    captureMessage: (message: string) => {
      if (current) {
        current.message = message;
        captured.push(current);
      }
    },
  };
}

afterEach(() => {
  resetDefaultLogSinkForTests();
});

describe("client sink pipeline (default sink → fanout → Sentry)", () => {
  test("a caught error logged via logger.error reaches Sentry with tags and fingerprint", () => {
    const captured: Captured[] = [];
    const silentConsole = { debug() {}, info() {}, warn() {}, error() {} };
    setDefaultLogSink(
      createFanoutSink([createConsoleSink({ console: silentConsole }), createSentryLogSink(fakeSentry(captured))]),
    );

    // Same shape as web/client call sites, e.g. use-thread-manager's thread.open_failed.
    const logger = createLogger({ scope: "web.client.threads" });
    logger.error("thread.open_failed", {
      message: "Failed to open thread",
      error: new Error("resume rejected"),
      threadId: "t-1",
    });

    expect(captured).toHaveLength(1);
    const event = captured[0]!;
    expect(event.tags.log_scope).toBe("web.client.threads");
    expect(event.tags.log_event).toBe("thread.open_failed");
    expect(event.fingerprint).toEqual(["web.client.threads", "thread.open_failed", "Error"]);
    expect((event.exception as Error).message).toBe("resume rejected");
  });

  test("info logs and excluded events do not reach Sentry", () => {
    const captured: Captured[] = [];
    setDefaultLogSink(createSentryLogSink(fakeSentry(captured)));

    const logger = createLogger({ scope: "web.client.threads" });
    logger.info("thread.opened", { message: "ok" });
    logger.error("parent.exited", { message: "shutdown" });

    expect(captured).toHaveLength(0);
  });
});
