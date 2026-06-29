// @summary Tests for shared user-facing error normalization
import { expect, test } from "bun:test";
import {
  getUserFacingErrorMessage,
  USER_FACING_CONTEXT_OVERFLOW_MESSAGE,
  USER_FACING_CONTEXT_OVERFLOW_MESSAGE_KO,
  USER_FACING_NETWORK_ERROR_MESSAGE,
} from "../src/errors";

test("normalizes context overflow errors in English by default", () => {
  expect(
    getUserFacingErrorMessage({
      message: "raw provider context error",
      name: "ProviderError",
      providerErrorType: "context_overflow",
    }),
  ).toBe(USER_FACING_CONTEXT_OVERFLOW_MESSAGE);
});

test("normalizes context overflow errors in Korean locale", () => {
  expect(
    getUserFacingErrorMessage(
      {
        message: "raw provider context error",
        name: "ProviderError",
        providerErrorType: "context_overflow",
      },
      "ko-KR",
    ),
  ).toBe(USER_FACING_CONTEXT_OVERFLOW_MESSAGE_KO);
});

test("normalizes network errors and leaves other errors alone", () => {
  expect(
    getUserFacingErrorMessage({
      message: "socket closed",
      name: "ProviderError",
      providerErrorType: "network",
    }),
  ).toBe(USER_FACING_NETWORK_ERROR_MESSAGE);

  expect(
    getUserFacingErrorMessage({
      message: "rate limited",
      name: "ProviderError",
      providerErrorType: "rate_limit",
    }),
  ).toBe("rate limited");
});
