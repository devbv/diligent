// @summary Tests runtime-owned diagnostic presentation and semantic recovery mapping

import { describe, expect, test } from "bun:test";
import type { SerializableError } from "@diligent/protocol";
import { presentRuntimeError } from "../../src/errors/presentation";

function diagnostic(overrides: Partial<SerializableError>): SerializableError {
  return { message: "raw provider detail", name: "ProviderError", ...overrides };
}

describe("presentRuntimeError", () => {
  test.each([
    [
      diagnostic({ providerErrorType: "auth", providerErrorReason: "credentials_missing" }),
      "Connect OpenAI to continue.",
      { kind: "configure_provider", provider: "openai" },
    ],
    [
      diagnostic({ providerErrorType: "auth", providerErrorReason: "credentials_rejected" }),
      "OpenAI rejected the saved credentials. Reconnect to continue.",
      { kind: "configure_provider", provider: "openai" },
    ],
    [
      diagnostic({ providerErrorType: "context_overflow", providerErrorReason: "context_window_exceeded" }),
      "This conversation is too long for the selected model. Start a new chat to continue.",
      { kind: "start_new_thread" },
    ],
    [
      diagnostic({ providerErrorType: "network", isRetryable: true }),
      "A network problem occurred. Please try again.",
      { kind: "retry" },
    ],
    [
      diagnostic({ providerErrorType: "server_error", isRetryable: true }),
      "The provider is temporarily unavailable. Please try again.",
      { kind: "retry" },
    ],
    [
      diagnostic({ providerErrorType: "rate_limit" }),
      "The provider rate limit was reached. Please try again later.",
      undefined,
    ],
  ])("maps diagnostics to common presentation", (error, message, recovery) => {
    const result = presentRuntimeError(error, { provider: "openai", operation: "agent_turn", retrySafe: true });

    expect(result.message).toBe("raw provider detail");
    expect(result.presentation?.message).toBe(message);
    expect(result.presentation?.recovery).toEqual(recovery);
  });

  test("does not mask unknown diagnostics", () => {
    const error = diagnostic({ providerErrorType: "unknown" });

    expect(presentRuntimeError(error, { operation: "app_server" })).toEqual(error);
  });

  test("omits retry recovery when replay is not safe", () => {
    const result = presentRuntimeError(diagnostic({ providerErrorType: "network" }), {
      operation: "compaction",
      retrySafe: false,
    });

    expect(result.presentation?.recovery).toBeUndefined();
  });
});
