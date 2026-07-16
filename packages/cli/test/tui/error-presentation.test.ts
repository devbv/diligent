// @summary Tests CLI-specific error recovery hints and legacy fallback

import { expect, test } from "bun:test";
import { formatClientErrorText } from "../../src/tui/error-presentation";

test("formats each semantic recovery as an explicit CLI hint", () => {
  expect(
    formatClientErrorText({
      name: "ProviderError",
      message: "raw",
      presentation: {
        message: "Reconnect.",
        recovery: { kind: "configure_provider", provider: "anthropic" },
      },
    }),
  ).toBe("Reconnect.\nRun /provider set anthropic to reconnect.");
  expect(
    formatClientErrorText({
      name: "ProviderError",
      message: "raw",
      presentation: { message: "Start over.", recovery: { kind: "start_new_thread" } },
    }),
  ).toBe("Start over.\nRun /new to start a new chat.");
  expect(
    formatClientErrorText({
      name: "ProviderError",
      message: "raw",
      presentation: { message: "Try again.", recovery: { kind: "retry" } },
    }),
  ).toBe("Try again.\nSubmit the last prompt again to retry.");
});

test("falls back to the raw diagnostic for older servers", () => {
  expect(formatClientErrorText({ name: "Error", message: "legacy failure" })).toBe("legacy failure");
});
