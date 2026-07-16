// @summary CLI-owned rendering of runtime error presentation and recovery hints

import type { ClientError } from "@diligent/protocol";

export function formatClientError(error: ClientError): { message: string; hint?: string } {
  const message = error.presentation?.message ?? error.message;
  const recovery = error.presentation?.recovery;

  switch (recovery?.kind) {
    case "configure_provider":
      return {
        message,
        hint: recovery.provider
          ? `Run /provider set ${recovery.provider} to reconnect.`
          : "Run /provider to reconnect.",
      };
    case "start_new_thread":
      return { message, hint: "Run /new to start a new chat." };
    case "retry":
      return { message, hint: "Submit the last prompt again to retry." };
    case undefined:
      return { message };
  }
}

export function formatClientErrorText(error: ClientError): string {
  const { message, hint } = formatClientError(error);
  return hint ? `${message}\n${hint}` : message;
}
