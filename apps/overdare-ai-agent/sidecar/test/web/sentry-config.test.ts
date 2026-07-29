// @summary Tests for the server→browser Sentry config injection contract.
import { describe, expect, test } from "bun:test";
import { injectSentryConfig, SENTRY_CONFIG_GLOBAL } from "../../src/web/shared/sentry-config";

const HTML = "<html><head><title>x</title></head><body></body></html>";

describe("injectSentryConfig", () => {
  test("injects a window global script before </head>", () => {
    const out = injectSentryConfig(HTML, {
      dsn: "https://k@h.ingest.sentry.io/1",
      environment: "prod",
      release: "0.4.19",
    });
    expect(out).toContain(`window.${SENTRY_CONFIG_GLOBAL}=`);
    expect(out.indexOf("<script>")).toBeLessThan(out.indexOf("</head>"));
    const json = out.match(/window\.__DILIGENT_SENTRY__=(\{.*?\});<\/script>/)?.[1];
    expect(JSON.parse(json ?? "")).toEqual({
      dsn: "https://k@h.ingest.sentry.io/1",
      environment: "prod",
      release: "0.4.19",
    });
  });

  test("returns html unchanged without config", () => {
    expect(injectSentryConfig(HTML, undefined)).toBe(HTML);
  });

  test("escapes </script> in values so the tag cannot be broken out of", () => {
    const out = injectSentryConfig(HTML, { dsn: "x</script><script>alert(1)</script>", environment: "dev" });
    expect(out).not.toContain("</script><script>alert(1)");
    expect(out).toContain("\\u003c/script>");
  });
});
