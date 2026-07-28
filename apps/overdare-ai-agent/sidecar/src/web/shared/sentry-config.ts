// @summary Server→browser Sentry config contract injected into index.html at serve time.
// The Bun server owns the values (SENTRY_DSN env gate, release, environment) and injects
// them as a window global; the React client reads the global and no-ops when absent
// (Vite dev server never injects, so local dev stays Sentry-free by construction).

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
