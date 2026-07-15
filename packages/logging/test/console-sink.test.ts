// @summary Verifies browser-safe console sink formatting, routing, and recursion marker behavior.

import { describe, expect, test } from "bun:test";
import {
  type ConsoleLike,
  createConsoleSink,
  createLogger,
  formatLogRecordText,
  isStructuredConsoleWriteInProgress,
  type LogRecord,
} from "../src";

function recordingConsole(calls: Array<{ method: keyof ConsoleLike; value: string; marked: boolean }>): ConsoleLike {
  return {
    debug(value) {
      calls.push({ method: "debug", value: String(value), marked: isStructuredConsoleWriteInProgress() });
    },
    info(value) {
      calls.push({ method: "info", value: String(value), marked: isStructuredConsoleWriteInProgress() });
    },
    warn(value) {
      calls.push({ method: "warn", value: String(value), marked: isStructuredConsoleWriteInProgress() });
    },
    error(value) {
      calls.push({ method: "error", value: String(value), marked: isStructuredConsoleWriteInProgress() });
    },
  };
}

describe("createConsoleSink", () => {
  test("routes each level to its matching console method", () => {
    const calls: Array<{ method: keyof ConsoleLike; value: string; marked: boolean }> = [];
    const logger = createLogger({
      scope: "routing",
      sink: createConsoleSink({ console: recordingConsole(calls), format: "json" }),
      clock: () => new Date("2026-01-02T03:04:05.006Z"),
    });

    logger.debug("one", "debug");
    logger.info("two", "info");
    logger.warn("three", "warn");
    logger.error("four", "error");

    expect(calls.map(({ method }) => method)).toEqual(["debug", "info", "warn", "error"]);
    expect(calls.every(({ marked }) => marked)).toBe(true);
    expect(calls.map(({ value }) => JSON.parse(value).level)).toEqual(["debug", "info", "warn", "error"]);
  });

  test("inserts timestamp and session immediately after a leading prefix", () => {
    const calls: Array<{ method: keyof ConsoleLike; value: string; marked: boolean }> = [];
    const logger = createLogger({
      scope: "format",
      sink: createConsoleSink({ console: recordingConsole(calls), format: "text" }),
      clock: () => new Date("2026-01-02T03:04:05.006Z"),
      context: { sessionId: "session-7" },
    });

    logger.info("retry", "[llm:retry] attempt scheduled");
    logger.info("plain", "ordinary message");

    expect(calls[0]?.value).toStartWith("[llm:retry] timestamp=2026-01-02T03:04:05.006Z sessionId=session-7 ");
    expect(calls[0]?.value).toContain("attempt scheduled");
    expect(calls[1]?.value).toStartWith("timestamp=2026-01-02T03:04:05.006Z sessionId=session-7 ordinary message");
  });

  test("uses n/a when sessionId is absent", () => {
    const calls: Array<{ method: keyof ConsoleLike; value: string; marked: boolean }> = [];
    createLogger({
      scope: "format",
      sink: createConsoleSink({ console: recordingConsole(calls) }),
      clock: () => new Date("2026-01-02T03:04:05.006Z"),
    }).info("event", "message");

    expect(calls[0]?.value).toStartWith("timestamp=2026-01-02T03:04:05.006Z sessionId=n/a ");
  });

  test("does not duplicate structured metadata already embedded in a retry message", () => {
    const calls: Array<{ method: keyof ConsoleLike; value: string; marked: boolean }> = [];
    createLogger({
      scope: "llm",
      sink: createConsoleSink({ console: recordingConsole(calls) }),
      clock: () => new Date("2026-01-02T03:04:05.006Z"),
    }).info("retry", {
      message:
        "[llm:retry] timestamp=2025-01-01T00:00:00.000Z sessionId=legacy provider=openai attempt=2 retry scheduled",
      fields: { provider: "openai", attempt: 2, delayMs: 100 },
    });

    expect(calls[0]?.value.match(/timestamp=/g)).toHaveLength(1);
    expect(calls[0]?.value.match(/sessionId=/g)).toHaveLength(1);
    expect(calls[0]?.value).not.toContain("sessionId=legacy");
    expect(calls[0]?.value.match(/provider=openai/g)).toHaveLength(1);
    expect(calls[0]?.value.match(/attempt=2/g)).toHaveLength(1);
    expect(calls[0]?.value).toContain("delayMs=100");
  });

  test("formats retry messages without timestamps while preserving prefix, session, and metadata deduplication", () => {
    const record: LogRecord = {
      timestamp: "2026-01-02T03:04:05.006Z",
      level: "info",
      scope: "llm",
      event: "retry",
      message:
        "[llm:retry] timestamp=2025-01-01T00:00:00.000Z sessionId=session-7 provider=openai attempt=2 retry scheduled",
      sessionId: "session-7",
      fields: { provider: "openai", attempt: 2, delayMs: 100 },
    };

    const formatted = formatLogRecordText(record, { includeTimestamp: false });

    expect(formatted).toStartWith("[llm:retry] sessionId=session-7 ");
    expect(formatted).not.toContain("timestamp=2026-01-02T03:04:05.006Z");
    expect(formatted).not.toContain("timestamp=2025-01-01T00:00:00.000Z");
    expect(formatted).toContain("retry scheduled");
    expect(formatted).toContain("delayMs=100");
    expect(formatted.match(/sessionId=/g)).toHaveLength(1);
    expect(formatted.match(/provider=openai/g)).toHaveLength(1);
    expect(formatted.match(/attempt=2/g)).toHaveLength(1);
  });

  test("clears the marker even when the injected console throws", () => {
    const throwingConsole: ConsoleLike = {
      debug() {},
      info() {
        expect(isStructuredConsoleWriteInProgress()).toBe(true);
        throw new Error("console failed");
      },
      warn() {},
      error() {},
    };
    const logger = createLogger({
      scope: "marker",
      sink: createConsoleSink({ console: throwingConsole }),
    });

    expect(() => logger.info("event", "message")).not.toThrow();
    expect(isStructuredConsoleWriteInProgress()).toBe(false);
  });
});
