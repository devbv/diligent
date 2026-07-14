// @summary Verifies structured logger records, context inheritance, filtering, defaults, and sink isolation.

import { afterEach, describe, expect, test } from "bun:test";
import {
  createFanoutSink,
  createLogger,
  isStructuredConsoleWriteInProgress,
  type LogRecord,
  noopLogger,
  resetDefaultLogSinkForTests,
  setDefaultLogSink,
} from "../src";

afterEach(() => {
  resetDefaultLogSinkForTests();
});

describe("createLogger", () => {
  test("creates one timestamp and merges parent, child, then event fields", () => {
    const records: LogRecord[] = [];
    let clockCalls = 0;
    const logger = createLogger({
      scope: "agent",
      sink: (record) => records.push(record),
      clock: () => {
        clockCalls += 1;
        return new Date("2026-01-02T03:04:05.006Z");
      },
      context: {
        sessionId: "session-1",
        fields: { inherited: true, winner: "parent" },
      },
    });

    const child = logger.child({
      threadId: "thread-1",
      fields: { child: true, winner: "child" },
    });
    child.info("turn.started", {
      message: "Starting turn",
      turnId: "turn-1",
      fields: { event: true, winner: "event" },
    });

    expect(clockCalls).toBe(1);
    expect(records).toEqual([
      {
        timestamp: "2026-01-02T03:04:05.006Z",
        level: "info",
        scope: "agent",
        event: "turn.started",
        message: "Starting turn",
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: "turn-1",
        fields: {
          inherited: true,
          winner: "event",
          child: true,
          event: true,
        },
      },
    ]);
  });

  test("does not mutate or retain mutable context inputs", () => {
    const records: LogRecord[] = [];
    const parentFields = { value: "initial" };
    const childFields = { child: "initial" };
    const parent = createLogger({
      scope: "immutability",
      sink: (record) => records.push(record),
      context: { fields: parentFields },
    });
    const child = parent.child({ fields: childFields });

    parentFields.value = "changed";
    childFields.child = "changed";
    child.info("event", "message");

    expect(records[0]?.fields).toEqual({ value: "initial", child: "initial" });
    expect(parentFields).toEqual({ value: "changed" });
    expect(childFields).toEqual({ child: "changed" });
  });

  test("allows child scope to override the resulting record scope", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      scope: "parent",
      sink: (record) => records.push(record),
    });

    logger
      .child({ scope: "child", fields: { inherited: true } })
      .info("event", { message: "message", fields: { local: true } });

    expect(records).toEqual([
      {
        timestamp: expect.any(String),
        level: "info",
        scope: "child",
        event: "event",
        message: "message",
        fields: {
          inherited: true,
          local: true,
        },
      },
    ]);
  });

  test("child scope overrides do not mutate the parent scope", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      scope: "parent",
      sink: (record) => records.push(record),
    });

    const child = logger.child({ scope: "child" });
    child.info("child.event", "child message");
    logger.info("parent.event", "parent message");

    expect(records.map(({ scope, event }) => ({ scope, event }))).toEqual([
      { scope: "child", event: "child.event" },
      { scope: "parent", event: "parent.event" },
    ]);
  });

  test("accepts an explicit child scope override without mutating inherited context scope", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      scope: "root",
      sink: (record) => records.push(record),
      context: { scope: "context-scope", fields: { inherited: true } },
    });

    const child = logger.child({ scope: "override", fields: { child: true } });
    child.info("child.event", "child message");
    logger.info("parent.event", "parent message");

    expect(records).toEqual([
      {
        timestamp: expect.any(String),
        level: "info",
        scope: "override",
        event: "child.event",
        message: "child message",
        fields: { inherited: true, child: true },
      },
      {
        timestamp: expect.any(String),
        level: "info",
        scope: "root",
        event: "parent.event",
        message: "parent message",
        fields: { inherited: true },
      },
    ]);
  });

  test("filters records below the minimum level", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      scope: "levels",
      minimumLevel: "warn",
      sink: (record) => records.push(record),
    });

    logger.debug("debug", "hidden");
    logger.info("info", "hidden");
    logger.warn("warn", "shown");
    logger.error("error", "shown");

    expect(records.map(({ level }) => level)).toEqual(["warn", "error"]);
  });

  test("uses the current default sink and reset restores console output", () => {
    const records: LogRecord[] = [];
    const consoleCalls: Array<{ value: string; marked: boolean }> = [];
    const loggerCreatedBeforeConfiguration = createLogger({ scope: "dynamic" });

    setDefaultLogSink((record) => records.push(record));
    loggerCreatedBeforeConfiguration.info("configured", "visible");

    expect(records.map(({ event }) => event)).toEqual(["configured"]);
    const originalConsoleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "console");
    const originalConsole = globalThis.console;
    try {
      Object.defineProperty(globalThis, "console", {
        configurable: true,
        value: {
          debug() {},
          info(value: unknown) {
            consoleCalls.push({
              value: String(value),
              marked: isStructuredConsoleWriteInProgress(),
            });
          },
          warn() {},
          error() {},
        },
      });
      resetDefaultLogSinkForTests();
      loggerCreatedBeforeConfiguration.info("reset", "console visible");
    } finally {
      if (originalConsoleDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "console");
      } else {
        Object.defineProperty(globalThis, "console", originalConsoleDescriptor);
      }
      resetDefaultLogSinkForTests();
    }

    expect(consoleCalls).toHaveLength(1);
    expect(consoleCalls[0]?.value).toContain("console visible");
    expect(consoleCalls[0]?.marked).toBe(true);
    expect(globalThis.console).toBe(originalConsole);
  });

  test("normalizes errors without trusting throwing properties", () => {
    const records: LogRecord[] = [];
    const hostileError = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostileError, "name", {
      get() {
        throw new Error("blocked");
      },
    });
    hostileError.message = "safe message";

    createLogger({ scope: "errors", sink: (record) => records.push(record) }).error("failed", {
      message: "Request failed",
      error: hostileError,
    });

    expect(records[0]?.error).toEqual({
      name: "Error",
      message: "safe message",
    });
  });

  test("normalizes circular error causes without recursing indefinitely", () => {
    const records: LogRecord[] = [];
    const error = new Error("outer") as Error & { cause?: unknown };
    error.cause = error;

    createLogger({ scope: "errors", sink: (record) => records.push(record) }).error("failed", { error });

    expect(records[0]?.error?.message).toBe("outer");
    expect(records[0]?.error?.cause).toEqual({
      name: "Error",
      message: "[Circular error cause]",
    });
  });

  test("contains synchronous throws and asynchronous rejections from sinks", async () => {
    const logger = createLogger({
      scope: "safe",
      sink: (record) => {
        if (record.event === "sync") throw new Error("sync sink failure");
        return Promise.reject(new Error("async sink failure"));
      },
    });

    expect(() => logger.info("sync", "message")).not.toThrow();
    expect(() => logger.info("async", "message")).not.toThrow();
    await Bun.sleep(0);
  });
});

describe("createFanoutSink", () => {
  test("isolates failing sinks and delivers to all remaining sinks", async () => {
    const deliveries: string[] = [];
    const sink = createFanoutSink([
      () => {
        throw new Error("first failed");
      },
      async () => {
        throw new Error("second failed");
      },
      (record) => deliveries.push(record.event),
    ]);

    createLogger({ scope: "fanout", sink }).info("delivered", "message");
    await Bun.sleep(0);

    expect(deliveries).toEqual(["delivered"]);
  });
});

test("noopLogger and its children accept every log call", () => {
  const child = noopLogger.child({ sessionId: "session" });
  expect(child).toBe(noopLogger);
  expect(() => {
    child.debug("debug", "message");
    child.info("info", "message");
    child.warn("warn", "message");
    child.error("error", { error: new Error("ignored") });
  }).not.toThrow();
});
