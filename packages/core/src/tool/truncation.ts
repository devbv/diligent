// @summary Auto-truncation of tool output with head, tail, and head_tail strategies

/** D025: Auto-truncation constants */
export const MAX_OUTPUT_BYTES = 50_000; // 50KB

/** WARNING marker injected into truncated output so LLM knows data is missing */
export const TRUNCATION_WARNING = "\n\n⚠️ WARNING: Output truncated. Some data has been omitted.";

export interface TruncationResult {
  output: string;
  truncated: boolean;
  originalBytes: number;
  savedPath?: string;
}

/** Check if output exceeds limits (optionally against a custom byte cap). */
export function shouldTruncate(output: string, maxBytes: number = MAX_OUTPUT_BYTES): boolean {
  const bytes = new TextEncoder().encode(output).length;
  return bytes > maxBytes;
}

/**
 * Keep the first portion (for file reads — beginning is most relevant).
 */
export function truncateHead(output: string, maxBytes: number = MAX_OUTPUT_BYTES): TruncationResult {
  const originalBytes = new TextEncoder().encode(output).length;

  if (originalBytes <= maxBytes) {
    return { output, truncated: false, originalBytes };
  }

  const result = truncateStringToBytes(output, maxBytes);

  return { output: result, truncated: true, originalBytes };
}

/**
 * Keep the last portion (for bash — recent output is most relevant).
 */
export function truncateTail(output: string, maxBytes: number = MAX_OUTPUT_BYTES): TruncationResult {
  const originalBytes = new TextEncoder().encode(output).length;

  if (originalBytes <= maxBytes) {
    return { output, truncated: false, originalBytes };
  }

  const encoder = new TextEncoder();
  const decoded = new TextDecoder();
  const encoded = encoder.encode(output);
  let result = decoded.decode(encoded.slice(-maxBytes));
  // Drop the potentially broken first character at UTF-8 boundary
  const firstNewline = result.indexOf("\n");
  if (firstNewline > 0 && firstNewline < 100) {
    result = result.slice(firstNewline + 1);
  }

  return { output: result, truncated: true, originalBytes };
}

/**
 * Keep both beginning and end of output (head_tail split).
 * Useful for shell/read_file where both the start context and final output matter.
 * Splits the byte budget: 40% head, 60% tail.
 */
export function truncateHeadTail(output: string, maxBytes: number = MAX_OUTPUT_BYTES): TruncationResult {
  const originalBytes = new TextEncoder().encode(output).length;

  if (originalBytes <= maxBytes) {
    return { output, truncated: false, originalBytes };
  }

  // Budget split: 40% head, 60% tail
  const headBytes = Math.floor(maxBytes * 0.4);
  const tailBytes = maxBytes - headBytes;

  // Get head portion
  const headResult = truncateHead(output, headBytes);
  const headPart = headResult.truncated ? headResult.output : output;

  // Get tail portion
  const tailResult = truncateTail(output, tailBytes);
  const tailPart = tailResult.truncated ? tailResult.output : output;

  // If neither needed truncation, return as-is
  if (!headResult.truncated && !tailResult.truncated) {
    return { output, truncated: false, originalBytes };
  }

  const omittedBytes =
    originalBytes - new TextEncoder().encode(headPart).length - new TextEncoder().encode(tailPart).length;

  const marker = `\n\n--- [${omittedBytes.toLocaleString()} bytes omitted] ---\n\n`;
  const combined = headPart + marker + tailPart;

  return { output: combined, truncated: true, originalBytes };
}

function truncateStringToBytes(str: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  // Fast path: if ASCII-only, direct slice
  if (encoder.encode(str).length === str.length) {
    return str.slice(0, maxBytes);
  }
  // For multi-byte chars, iterate codepoints
  let byteCount = 0;
  let i = 0;
  while (i < str.length) {
    const codePoint = str.codePointAt(i)!;
    const charBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (byteCount + charBytes > maxBytes) break;
    byteCount += charBytes;
    i += codePoint > 0xffff ? 2 : 1;
  }
  return str.slice(0, i);
}
