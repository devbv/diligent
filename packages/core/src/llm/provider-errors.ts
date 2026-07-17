// @summary Shared HTTP status predicates and baseline provider error classification
import { ProviderError, ProviderErrorReason, ProviderErrorType } from "./types";

export function isAuthenticationStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

export function isRateLimitStatus(status: number | undefined): boolean {
  return status === 429;
}

export function isServerErrorStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 500;
}

export interface ClassifyProviderHttpErrorOptions {
  message: string;
  status: number | undefined;
  cause?: Error;
  retryAfterMs?: number;
}

/** Classify HTTP failures whose meaning is shared by every provider. */
export function classifyProviderHttpError(options: ClassifyProviderHttpErrorOptions): ProviderError | undefined {
  const { message, status, cause, retryAfterMs } = options;
  if (isRateLimitStatus(status)) {
    return new ProviderError(message, {
      errorType: ProviderErrorType.RateLimit,
      isRetryable: false,
      retryAfterMs,
      statusCode: status,
      cause,
    });
  }
  if (isAuthenticationStatus(status)) {
    return new ProviderError(message, {
      errorType: ProviderErrorType.Auth,
      isRetryable: false,
      statusCode: status,
      cause,
      reason: ProviderErrorReason.CredentialsRejected,
    });
  }
  if (isServerErrorStatus(status)) {
    return new ProviderError(message, {
      errorType: ProviderErrorType.ServerError,
      isRetryable: true,
      statusCode: status,
      cause,
    });
  }
  return undefined;
}
