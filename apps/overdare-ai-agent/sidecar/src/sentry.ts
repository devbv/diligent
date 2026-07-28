// @summary Sentry error-monitoring init for the sidecar process (Sentry project: diligent-agent).
// Imported first from server.ts so the SDK hooks process-level error handlers before
// any runtime assembly. No-ops when no DSN is configured (local dev, tests).
//
// Privacy policy (docs/plan/infra/sentry-integration.md): telemetry is operational
// diagnostics outside the OVERDARE consent gate, so scrubbing is mandatory —
// error diagnostics only, never conversation content, user paths, or tokens.

import { homedir } from "node:os";
import type { LogRecord, LogSink } from "@diligent/logging";
import * as Sentry from "@sentry/bun";

// DSNs are public identifiers, not secrets — safe to inline (Sentry project: diligent-agent).
const DEFAULT_DSN = "https://df4934a1d409febff5da85d23ed88b74@o4507586380890112.ingest.us.sentry.io/4511811350560768";

// SENTRY_DSN env always wins when set (empty string = explicit off). When unset, the
// inlined DSN applies only to launcher-managed runs — DILIGENT_SERVER_VERSION is
// injected by the Rust launcher (webserver.rs), so plain local `bun run` stays no-op.
const envDsn = process.env.SENTRY_DSN;
const dsn =
  envDsn !== undefined ? envDsn.trim() || undefined : process.env.DILIGENT_SERVER_VERSION ? DEFAULT_DSN : undefined;

if (dsn) {
  const home = homedir();

  Sentry.init({
    dsn,
    release: process.env.DILIGENT_SERVER_VERSION,
    environment: process.env.DILIGENT_ENV ?? "dev",
    sendDefaultPii: false,
    // SENTRY_TEST=1 marks the whole run as a manual test: events still record,
    // but alert rules filter on no_alert != true so the Slack channel stays quiet.
    initialScope: process.env.SENTRY_TEST ? { tags: { no_alert: "true" } } : undefined,
    // ponytail: drop all breadcrumbs — console output may echo prompt/message
    // content. Re-enable selectively (category allowlist) if triage needs them.
    beforeBreadcrumb: () => null,
    beforeSend(event) {
      // Scrub the user's home directory everywhere in the event (stack frames,
      // extras, messages) so usernames never leave the machine.
      return JSON.parse(JSON.stringify(event).split(home).join("~")) as typeof event;
    },
  });
}

// Error-level events that must NOT be reported:
// - parent.exited is the watchdog's normal shutdown path when Studio closes.
// - process.* are already captured natively by the SDK's global handlers with
//   full stack traces; reporting them from the log sink would double-count.
const SINK_EXCLUDED_EVENTS = new Set(["parent.exited", "process.uncaught_exception", "process.unhandled_rejection"]);

// Warn-level events that ARE worth reporting: silent product degradation that
// no error-level path ever surfaces (e.g. an agent-loop hook permanently disabled).
const SINK_WARN_ALLOWLIST = new Set(["agent_loop_hook_disabled"]);

/** Decides which structured log records become Sentry events (exported for tests). */
export function shouldReportLogRecord(record: Pick<LogRecord, "level" | "event">): boolean {
  if (record.level === "error") return !SINK_EXCLUDED_EVENTS.has(record.event);
  if (record.level === "warn") return SINK_WARN_ALLOWLIST.has(record.event);
  return false;
}

/**
 * Log sink forwarding handled-but-reportable failures (turn run errors, persist
 * failures, startup errors, ...) to Sentry. The agent loop catches provider/tool
 * errors before they can crash the process, so the SDK's global handlers never
 * see them — every such site already calls logger.error, making the log pipeline
 * the single gateway. Sends only structured diagnostics (scope, event, normalized
 * error); free-text message and fields stay local, they may carry content.
 */
export function createSentryLogSink(): LogSink {
  return (record) => {
    if (!shouldReportLogRecord(record) || !Sentry.getClient()) return;
    try {
      Sentry.withScope((scope) => {
        scope.setTag("log_scope", record.scope);
        scope.setTag("log_event", record.event);
        if (record.sessionId) scope.setTag("session_id", record.sessionId);
        if (record.turnId) scope.setTag("turn_id", record.turnId);
        // Group by log site + error type, not by message variance.
        scope.setFingerprint([record.scope, record.event, record.error?.name ?? "no-error"]);
        scope.setLevel(record.level === "warn" ? "warning" : "error");
        if (record.error) {
          const error = new Error(record.error.message);
          error.name = record.error.name;
          if (record.error.stack) error.stack = record.error.stack;
          Sentry.captureException(error);
        } else {
          Sentry.captureMessage(`${record.scope}: ${record.event}`);
        }
      });
    } catch {
      // The log pipeline must never fail because reporting did.
    }
  };
}
