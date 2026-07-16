// @summary User-facing error message normalization for Web render state

import type { AgentEvent } from "@diligent/protocol";

type SerializableError = Extract<AgentEvent, { type: "error" }>["error"];

export const USER_FACING_NETWORK_ERROR_MESSAGE = "A network problem occurred. Please try again.";

export function getUserFacingErrorMessage(error: SerializableError): string {
  if (error.presentation) {
    return error.presentation.message;
  }
  if (error.providerErrorType === "network") {
    return USER_FACING_NETWORK_ERROR_MESSAGE;
  }
  return error.message;
}
