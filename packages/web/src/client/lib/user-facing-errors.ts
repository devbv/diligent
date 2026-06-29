// @summary User-facing error message normalization for Web render state

import type { AgentEvent } from "@diligent/protocol";
import {
  getUserFacingErrorMessage as getProtocolUserFacingErrorMessage,
  USER_FACING_CONTEXT_OVERFLOW_MESSAGE,
  USER_FACING_CONTEXT_OVERFLOW_MESSAGE_KO,
  USER_FACING_NETWORK_ERROR_MESSAGE,
} from "@diligent/protocol";

type SerializableError = Extract<AgentEvent, { type: "error" }>["error"];

export {
  USER_FACING_CONTEXT_OVERFLOW_MESSAGE,
  USER_FACING_CONTEXT_OVERFLOW_MESSAGE_KO,
  USER_FACING_NETWORK_ERROR_MESSAGE,
};

export function getUserFacingErrorMessage(error: SerializableError): string {
  const locale = typeof navigator === "undefined" ? "en" : navigator.language;
  return getProtocolUserFacingErrorMessage(error, locale);
}
