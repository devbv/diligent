// @summary Runtime-owned mapping from core diagnostics to client-facing error presentation

import { PROVIDER_DISPLAY_NAMES } from "@diligent/core/llm/provider-manager";
import type { ClientError, ErrorRecovery, ProviderName, SerializableError } from "@diligent/protocol";

export interface RuntimeErrorPresentationContext {
  provider?: ProviderName;
  operation: "agent_turn" | "compaction" | "app_server";
  retrySafe?: boolean;
}

export function presentRuntimeError(error: SerializableError, context: RuntimeErrorPresentationContext): ClientError {
  const provider = context.provider;
  const providerLabel = provider ? PROVIDER_DISPLAY_NAMES[provider] : "The selected provider";

  switch (error.providerErrorType) {
    case "auth":
      if (error.providerErrorReason === "credentials_missing") {
        return withPresentation(error, `Connect ${providerLabel} to continue.`, {
          kind: "configure_provider",
          provider,
        });
      }
      return withPresentation(error, `${providerLabel} rejected the saved credentials. Reconnect to continue.`, {
        kind: "configure_provider",
        provider,
      });

    case "context_overflow":
      return withPresentation(
        error,
        "This conversation is too long for the selected model. Start a new chat to continue.",
        {
          kind: "start_new_thread",
        },
      );

    case "network":
      return withPresentation(
        error,
        "A network problem occurred. Please try again.",
        context.retrySafe ? { kind: "retry" } : undefined,
      );

    case "server_error":
      return withPresentation(
        error,
        "The provider is temporarily unavailable. Please try again.",
        context.retrySafe ? { kind: "retry" } : undefined,
      );

    case "rate_limit":
      return withPresentation(error, "The provider rate limit was reached. Please try again later.");

    case "unknown":
    case undefined:
      return { ...error };
  }
}

function withPresentation(error: SerializableError, message: string, recovery?: ErrorRecovery): ClientError {
  return {
    ...error,
    presentation: {
      message,
      ...(recovery ? { recovery } : {}),
    },
  };
}
