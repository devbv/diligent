// @summary Sentry browser init for the React client (Sentry project: diligent-agent).
// Reads the config the Bun server injected into index.html; no-ops when absent
// (Vite dev mode, or server running without SENTRY_DSN). Same privacy policy as
// the server SDK (docs/plan/infra/sentry-integration.md): diagnostics only.

import { createConsoleSink, createFanoutSink, createLogger, setDefaultLogSink } from "@diligent/logging";
import * as Sentry from "@sentry/react";
import { createSentryLogSink, SENTRY_CONFIG_GLOBAL, type SentryClientConfig } from "../shared/sentry-config";

const config = (window as unknown as Record<string, unknown>)[SENTRY_CONFIG_GLOBAL] as SentryClientConfig | undefined;

if (config?.dsn) {
  Sentry.init({
    dsn: config.dsn,
    release: config.release,
    environment: config.environment,
    sendDefaultPii: false,
    initialScope: config.noAlert ? { tags: { no_alert: "true" } } : undefined,
    // ponytail: drop all breadcrumbs — console/fetch crumbs may echo thread content.
    // Re-enable with a category allowlist if triage needs them.
    beforeBreadcrumb: () => null,
  });
  // Client code catches RPC/UI failures and logs them (thread.open_failed,
  // message.send_failed, ...), so the SDK's global handlers never see them —
  // route the client loggers' error records to Sentry, same as the server.
  setDefaultLogSink(createFanoutSink([createConsoleSink(), createSentryLogSink(Sentry)]));

  if (config.noAlert) {
    // SENTRY_TEST-gated E2E hook: real client log-error triggers (RPC failures,
    // toasts) are hard to force from automation because the UI guards them, so
    // test runs get an explicit way to push one record through the installed
    // sink chain. Never present in production (noAlert requires SENTRY_TEST).
    (window as unknown as Record<string, unknown>).__diligentSentrySinkTest = () => {
      createLogger({ scope: "web.client.sentry-test" }).error("sentry.client_sink_e2e", {
        message: "client sink e2e hook",
        error: new Error("client sink e2e"),
      });
    };
  }
}
