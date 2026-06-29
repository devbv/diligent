// @summary User-facing error message normalization shared by clients

import type { SerializableError } from "./data-model";

export const USER_FACING_NETWORK_ERROR_MESSAGE = "A network problem occurred. Please try again.";
export const USER_FACING_CONTEXT_OVERFLOW_MESSAGE =
  "This conversation has exceeded the AI model's context limit. To continue, open the menu in the top-left corner and start a new chat.";
export const USER_FACING_CONTEXT_OVERFLOW_MESSAGE_KO =
  "대화가 너무 길어져 AI가 더 이상 처리할 수 없어요. 좌상단 메뉴에서 새 대화를 시작하면 계속 작업할 수 있습니다.";

export function getUserFacingErrorMessage(error: SerializableError, locale = "en"): string {
  if (error.providerErrorType === "network") return USER_FACING_NETWORK_ERROR_MESSAGE;
  if (error.providerErrorType === "context_overflow") {
    return locale.toLowerCase().startsWith("ko")
      ? USER_FACING_CONTEXT_OVERFLOW_MESSAGE_KO
      : USER_FACING_CONTEXT_OVERFLOW_MESSAGE;
  }
  return error.message;
}
