// @summary Server→browser Sentry config contract and the shared structured-log Sentry sink.
// The Bun server owns the values (SENTRY_DSN env gate, release, environment) and injects
// them as a window global; the React client reads the global and no-ops when absent
// (Vite dev server never injects, so local dev stays Sentry-free by construction).

import type { LogRecord, LogSink } from "@diligent/logging";

export const SENTRY_CONFIG_GLOBAL = "__DILIGENT_SENTRY__";

export interface SentryClientConfig {
  dsn: string;
  release?: string;
  environment: string;
  /** Manual test run (server had SENTRY_TEST set): tag events no_alert so alert rules skip them. */
  noAlert?: boolean;
}

/** Injects the config as an inline script before </head>. Returns html unchanged when no config. */
export function injectSentryConfig(html: string, config: SentryClientConfig | undefined): string {
  if (!config) return html;
  // <-escape so a value containing "</script>" cannot break out of the tag.
  const json = JSON.stringify(config).replaceAll("<", "\\u003c");
  return html.replace("</head>", `<script>window.${SENTRY_CONFIG_GLOBAL}=${json};</script></head>`);
}

// ---------------------------------------------------------------------------
// Structured-log → Sentry forwarding, shared by the Bun server (@sentry/bun)
// and the browser client (@sentry/react). The agent loop and the UI both catch
// their errors before anything can crash, so the SDKs' global handlers never
// see them — every such site already calls logger.error/warn, making the log
// pipeline the single reporting gateway.

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

/** Structural facade over the parts of a Sentry SDK module the log sink needs. */
export interface SentryLogClient {
  getClient(): unknown;
  withScope(callback: (scope: SentryLogScope) => void): unknown;
  captureException(error: unknown): unknown;
  captureMessage(message: string): unknown;
}

export interface SentryLogScope {
  setTag(key: string, value: string): unknown;
  setFingerprint(fingerprint: string[]): unknown;
  setLevel(level: "error" | "warning"): unknown;
}

/**
 * Builds a log sink forwarding handled-but-reportable failures to Sentry.
 * Sends only structured diagnostics (scope, event, normalized error, IDs);
 * free-text message and fields stay local — they may carry content.
 */
export function createSentryLogSink(sentry: SentryLogClient): LogSink {
  return (record) => {
    if (!shouldReportLogRecord(record) || !sentry.getClient()) return;
    try {
      sentry.withScope((scope) => {
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
          sentry.captureException(error);
        } else {
          sentry.captureMessage(`${record.scope}: ${record.event}`);
        }
      });
    } catch {
      // The log pipeline must never fail because reporting did.
    }
  };
}
