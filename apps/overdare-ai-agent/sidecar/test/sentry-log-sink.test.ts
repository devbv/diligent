// @summary Tests for the Sentry log-sink reporting decision.
import { describe, expect, test } from "bun:test";
import { shouldReportLogRecord } from "../src/web/shared/sentry-config";

describe("shouldReportLogRecord", () => {
  test("reports error-level records", () => {
    expect(shouldReportLogRecord({ level: "error", event: "run_failed" })).toBe(true);
    expect(shouldReportLogRecord({ level: "error", event: "persist_entry_failed" })).toBe(true);
  });

  test("skips excluded error events (normal shutdown, SDK-native captures)", () => {
    expect(shouldReportLogRecord({ level: "error", event: "parent.exited" })).toBe(false);
    expect(shouldReportLogRecord({ level: "error", event: "process.uncaught_exception" })).toBe(false);
    expect(shouldReportLogRecord({ level: "error", event: "process.unhandled_rejection" })).toBe(false);
  });

  test("reports only allowlisted warn events", () => {
    expect(shouldReportLogRecord({ level: "warn", event: "agent_loop_hook_disabled" })).toBe(true);
    expect(shouldReportLogRecord({ level: "warn", event: "anything_else" })).toBe(false);
  });

  test("never reports info or debug", () => {
    expect(shouldReportLogRecord({ level: "info", event: "run_failed" })).toBe(false);
    expect(shouldReportLogRecord({ level: "debug", event: "run_failed" })).toBe(false);
  });
});
