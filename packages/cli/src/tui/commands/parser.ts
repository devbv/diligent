export interface ParsedCommand {
  name: string;
  args?: string;
  raw: string;
}

/**
 * Parse a slash command from input text.
 * Returns null if the text is not a command (doesn't start with /).
 *
 * Supports:
 *   /help           → { name: "help", args: undefined }
 *   /model gpt-4o   → { name: "model", args: "gpt-4o" }
 *   /skill:review   → { name: "skill:review", args: undefined }
 *   //escaped        → null (double-slash escape)
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  if (trimmed.startsWith("//")) return null;

  const withoutSlash = trimmed.slice(1);
  if (withoutSlash.length === 0) return null;

  const spaceIdx = withoutSlash.indexOf(" ");

  if (spaceIdx === -1) {
    return { name: withoutSlash, args: undefined, raw: trimmed };
  }

  return {
    name: withoutSlash.slice(0, spaceIdx),
    args: withoutSlash.slice(spaceIdx + 1).trim() || undefined,
    raw: trimmed,
  };
}

/**
 * Check if text looks like a command (for autocomplete triggering).
 */
export function isCommandPrefix(text: string): boolean {
  return text.startsWith("/") && !text.startsWith("//");
}
