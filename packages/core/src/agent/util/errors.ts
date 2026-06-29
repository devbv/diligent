// @summary Agent error serialization helpers for event-safe provider and runtime failures

import { ProviderError } from "../../llm/types";
import type { SerializableError } from "../types";

function extractErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate = err as Record<string, unknown>;
  const directCode = candidate.code;
  if (typeof directCode === "string" && directCode.trim().length > 0) {
    return directCode;
  }
  const nestedError = candidate.error;
  if (nestedError && typeof nestedError === "object") {
    const nestedCode = (nestedError as Record<string, unknown>).code;
    if (typeof nestedCode === "string" && nestedCode.trim().length > 0) {
      return nestedCode;
    }
  }
  return undefined;
}

// D086: Convert Error to serializable representation for event consumers.
export function toSerializableError(err: unknown): SerializableError {
  if (err instanceof ProviderError) {
    return {
      message: err.message,
      name: err.name,
      stack: err.stack,
      code: extractErrorCode(err.cause) ?? extractErrorCode(err),
      providerErrorType: err.errorType,
      isRetryable: err.isRetryable,
      retryAfterMs: err.retryAfterMs,
      statusCode: err.statusCode,
    };
  }

  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack, code: extractErrorCode(err) };
  }

  return { message: String(err), name: "Error" };
}

export function formatSerializableErrorForLog(error: SerializableError): string {
  const fields = [
    `name=${error.name}`,
    `message=${error.message}`,
    `code=${error.code ?? "n/a"}`,
    `type=${error.providerErrorType ?? "n/a"}`,
    `status=${error.statusCode ?? "n/a"}`,
    `retryable=${error.isRetryable ?? "n/a"}`,
  ];
  if (error.retryAfterMs !== undefined) {
    fields.push(`retryAfterMs=${error.retryAfterMs}`);
  }
  return fields.join(" ");
}
