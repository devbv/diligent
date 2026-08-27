// @summary Sentry error-monitoring init for the sidecar process (Sentry project: diligent-agent).
// Imported first from server.ts so the SDK hooks process-level error handlers before
// any runtime assembly. No-ops when no DSN is configured (local dev, tests).
//
// Privacy policy (docs/plan/infra/sentry-integration.md): telemetry is operational
// diagnostics outside the OVERDARE consent gate, so scrubbing is mandatory —
// error diagnostics only, never conversation content, user paths, or tokens.

import { homedir } from "node:os";
import type { LogSink } from "@diligent/logging";
import * as Sentry from "@sentry/bun";
import { createSentryLogSink as createSharedSentryLogSink } from "./web/shared/sentry-config";

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
    // Launcher-injected deployment context (opaque IDs, no content) rides on every
    // event so issues can be sliced by project / hub without extra plumbing.
    initialScope: {
      tags: {
        ...(process.env.SENTRY_TEST ? { no_alert: "true" } : {}),
        ...(process.env.OVERDARE_PROJECT_ID ? { overdare_project_id: process.env.OVERDARE_PROJECT_ID } : {}),
        ...(process.env.HUB_DOMAIN ? { hub_domain: process.env.HUB_DOMAIN } : {}),
      },
    },
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

/**
 * Server-side Sentry log sink (turn run errors, persist failures, startup
 * errors, ...). Implementation and filtering rules are shared with the browser
 * client in web/shared/sentry-config.ts.
 */
export function createSentryLogSink(): LogSink {
  return createSharedSentryLogSink(Sentry);
}

/**
 * Awaits pending Sentry transport sends. The transport is async, so any
 * `process.exit` that follows a captured error without this drops the event
 * (seen live: 27 startup.failed exits on 2026-08-13 arrived as zero events).
 */
export function flushSentry(timeoutMs = 2000): Promise<boolean> {
  return Sentry.flush(timeoutMs).catch(() => false);
}
