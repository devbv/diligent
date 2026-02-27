import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** D025: Auto-truncation constants */
export const MAX_OUTPUT_BYTES = 50_000; // 50KB
export const MAX_OUTPUT_LINES = 2_000;

/** WARNING marker injected into truncated output so LLM knows data is missing */
export const TRUNCATION_WARNING =
  "\n\n⚠️ WARNING: Output truncated. Some data has been omitted. Full output saved to disk.";

export interface TruncationResult {
  output: string;
  truncated: boolean;
  originalBytes: number;
  originalLines: number;
  savedPath?: string;
}

/** Check if output exceeds limits */
export function shouldTruncate(output: string): boolean {
  const bytes = new TextEncoder().encode(output).length;
  if (bytes > MAX_OUTPUT_BYTES) return true;
  const lines = countLines(output);
  if (lines > MAX_OUTPUT_LINES) return true;
  return false;
}

/**
 * Keep the first portion (for file reads — beginning is most relevant).
 * Phase 1: char-based truncation first (handles pathological cases like 2-line 10MB).
 * Phase 2: line-based truncation for readability.
 */
export function truncateHead(
  output: string,
  maxBytes: number = MAX_OUTPUT_BYTES,
  maxLines: number = MAX_OUTPUT_LINES,
): TruncationResult {
  const originalBytes = new TextEncoder().encode(output).length;
  const originalLines = countLines(output);

  if (originalBytes <= maxBytes && originalLines <= maxLines) {
    return { output, truncated: false, originalBytes, originalLines };
  }

  let result = output;

  // Phase 1: Truncate by bytes first (handles pathological cases)
  const encoder = new TextEncoder();
  if (encoder.encode(result).length > maxBytes) {
    result = truncateStringToBytes(result, maxBytes);
  }

  // Phase 2: Truncate by lines for readability (keep first N lines)
  if (countLines(result) > maxLines) {
    const lines = result.split("\n");
    result = lines.slice(0, maxLines).join("\n");
  }

  return { output: result, truncated: true, originalBytes, originalLines };
}

/**
 * Keep the last portion (for bash — recent output is most relevant).
 * Phase 1: char-based truncation first.
 * Phase 2: line-based truncation for readability.
 */
export function truncateTail(
  output: string,
  maxBytes: number = MAX_OUTPUT_BYTES,
  maxLines: number = MAX_OUTPUT_LINES,
): TruncationResult {
  const originalBytes = new TextEncoder().encode(output).length;
  const originalLines = countLines(output);

  if (originalBytes <= maxBytes && originalLines <= maxLines) {
    return { output, truncated: false, originalBytes, originalLines };
  }

  let result = output;

  // Phase 1: Truncate by bytes first (keep tail)
  const encoder = new TextEncoder();
  if (encoder.encode(result).length > maxBytes) {
    const decoded = new TextDecoder();
    const encoded = encoder.encode(result);
    result = decoded.decode(encoded.slice(-maxBytes));
    // Drop the potentially broken first character at UTF-8 boundary
    const firstNewline = result.indexOf("\n");
    if (firstNewline > 0 && firstNewline < 100) {
      result = result.slice(firstNewline + 1);
    }
  }

  // Phase 2: Truncate by lines for readability (keep last N lines)
  if (countLines(result) > maxLines) {
    const lines = result.split("\n");
    result = lines.slice(-maxLines).join("\n");
  }

  return { output: result, truncated: true, originalBytes, originalLines };
}

/**
 * Keep both beginning and end of output (head_tail split).
 * Useful for shell/read_file where both the start context and final output matter.
 * Splits the byte/line budget: 40% head, 60% tail.
 */
export function truncateHeadTail(
  output: string,
  maxBytes: number = MAX_OUTPUT_BYTES,
  maxLines: number = MAX_OUTPUT_LINES,
): TruncationResult {
  const originalBytes = new TextEncoder().encode(output).length;
  const originalLines = countLines(output);

  if (originalBytes <= maxBytes && originalLines <= maxLines) {
    return { output, truncated: false, originalBytes, originalLines };
  }

  // Budget split: 40% head, 60% tail
  const headBytes = Math.floor(maxBytes * 0.4);
  const tailBytes = maxBytes - headBytes;
  const headLines = Math.floor(maxLines * 0.4);
  const tailLines = maxLines - headLines;

  // Get head portion
  const headResult = truncateHead(output, headBytes, headLines);
  const headPart = headResult.truncated ? headResult.output : output;

  // Get tail portion
  const tailResult = truncateTail(output, tailBytes, tailLines);
  const tailPart = tailResult.truncated ? tailResult.output : output;

  // If neither needed truncation, return as-is
  if (!headResult.truncated && !tailResult.truncated) {
    return { output, truncated: false, originalBytes, originalLines };
  }

  const omittedBytes = originalBytes - new TextEncoder().encode(headPart).length - new TextEncoder().encode(tailPart).length;
  const omittedLines = originalLines - countLines(headPart) - countLines(tailPart);

  const marker = `\n\n--- [${omittedBytes.toLocaleString()} bytes / ${omittedLines.toLocaleString()} lines omitted] ---\n\n`;
  const combined = headPart + marker + tailPart;

  return { output: combined, truncated: true, originalBytes, originalLines };
}

/** Save full output to temp file, return path */
export async function persistFullOutput(output: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diligent-"));
  const filePath = join(dir, "full-output.txt");
  await writeFile(filePath, output, "utf-8");
  return filePath;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
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
