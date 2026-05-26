// @summary Shared error classification utilities for all providers

/**
 * Check if an error is a network-level failure (connection refused, timeout, etc.).
 * Shared across all providers to avoid duplication.
 */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  if (err.name === "TimeoutError") return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("fetch failed") ||
    msg.includes("network")
  );
}
