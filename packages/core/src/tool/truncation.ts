import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** D025: Auto-truncation constants */
export const MAX_OUTPUT_BYTES = 50_000; // 50KB
export const MAX_OUTPUT_LINES = 2_000;

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

/** Keep the first N lines / N bytes (for file reads — beginning is most relevant) */
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

  // Truncate by lines first (keep first N lines)
  if (originalLines > maxLines) {
    const lines = result.split("\n");
    result = lines.slice(0, maxLines).join("\n");
  }

  // Then truncate by bytes if still over
  const encoder = new TextEncoder();
  if (encoder.encode(result).length > maxBytes) {
    // Binary search for the right cut point
    result = truncateStringToBytes(result, maxBytes);
  }

  return { output: result, truncated: true, originalBytes, originalLines };
}

/** Keep the last N lines / N bytes (for bash — recent output is most relevant) */
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

  // Truncate by lines first (keep last N lines)
  if (originalLines > maxLines) {
    const lines = result.split("\n");
    result = lines.slice(-maxLines).join("\n");
  }

  // Then truncate by bytes if still over (keep tail)
  const encoder = new TextEncoder();
  if (encoder.encode(result).length > maxBytes) {
    const decoded = new TextDecoder();
    const encoded = encoder.encode(result);
    result = decoded.decode(encoded.slice(-maxBytes));
    // Drop the potentially broken first character
    const firstNewline = result.indexOf("\n");
    if (firstNewline > 0 && firstNewline < 100) {
      result = result.slice(firstNewline + 1);
    }
  }

  return { output: result, truncated: true, originalBytes, originalLines };
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
