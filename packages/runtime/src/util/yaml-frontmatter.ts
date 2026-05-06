// @summary Shared YAML-style frontmatter parser used by SKILL.md and AGENT.md
//
// Supports a small subset of YAML for frontmatter blocks:
// - `key: value` plain scalar (with optional surrounding single/double quotes)
// - `key: |` literal block scalar (preserves newlines)
// - `key: >` folded block scalar (consecutive lines fold to spaces, blank lines become newlines)
// - Chomp indicators `-` (strip trailing newlines) and `+` (keep trailing newlines)
// - Plain scalar continuation: an indented line without `:` is appended to the previous value with a space
// - `#` comment lines and blank lines are skipped

const BLOCK_SCALAR_PATTERN = /^([|>])([+-]?)\s*$/;

function getIndent(line: string): number {
  return line.length - line.trimStart().length;
}

function readBlockScalar(
  lines: string[],
  startIdx: number,
  parentIndent: number,
): { content: string[]; nextIdx: number } {
  const block: string[] = [];
  let blockIndent = -1;
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      block.push("");
      i++;
      continue;
    }
    const indent = getIndent(line);
    if (indent <= parentIndent) break;
    if (blockIndent === -1) blockIndent = indent;
    if (indent < blockIndent) break;
    block.push(line.slice(blockIndent));
    i++;
  }
  return { content: block, nextIdx: i };
}

function applyBlockStyle(block: string[], style: "|" | ">", chomp: "" | "-" | "+"): string {
  // Separate trailing empty lines so chomping can be applied correctly
  const lines = block.slice();
  let trailingEmpties = 0;
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
    trailingEmpties++;
  }

  let value: string;
  if (style === "|") {
    value = lines.join("\n");
  } else {
    // Folded: contiguous non-empty lines join with space; blank lines preserved as newlines
    const out: string[] = [];
    let buffer: string[] = [];
    for (const line of lines) {
      if (line === "") {
        if (buffer.length > 0) {
          out.push(buffer.join(" "));
          buffer = [];
        }
        out.push("");
      } else {
        buffer.push(line);
      }
    }
    if (buffer.length > 0) out.push(buffer.join(" "));
    value = out.join("\n");
  }

  if (chomp === "-") {
    return value;
  }
  if (chomp === "+") {
    return value === "" ? "" : `${value}\n${"\n".repeat(trailingEmpties)}`;
  }
  // clip (default): single trailing newline if value is non-empty
  return value === "" ? "" : `${value}\n`;
}

/**
 * Parse a `---`-delimited frontmatter block at the start of the given content.
 *
 * Returns the raw key-value map plus the un-trimmed body that follows the
 * closing `---`. Domain-specific validation (required fields, length limits,
 * type coercion) is the caller's responsibility.
 */
export function parseYamlFrontmatter(
  content: string,
  filePath: string,
): { parsed: Record<string, string>; body: string } | { error: string } {
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { error: `${filePath}: missing frontmatter (no opening ---)` };
  }

  let closingIdx = -1;
  for (let idx = 1; idx < lines.length; idx++) {
    if (lines[idx].trim() === "---") {
      closingIdx = idx;
      break;
    }
  }
  if (closingIdx === -1) {
    return { error: `${filePath}: missing frontmatter (no closing ---)` };
  }

  const kvLines = lines.slice(1, closingIdx);
  const parsed: Record<string, string> = {};

  let i = 0;
  while (i < kvLines.length) {
    const rawLine = kvLines[i];
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const indent = getIndent(rawLine);
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      return { error: `${filePath}: invalid frontmatter line: ${trimmed}` };
    }

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    i++;

    // Block scalar (|, >, with optional - or + chomp)?
    const blockMatch = BLOCK_SCALAR_PATTERN.exec(value);
    if (blockMatch) {
      const style = blockMatch[1] as "|" | ">";
      const chomp = (blockMatch[2] || "") as "" | "-" | "+";
      const { content: block, nextIdx } = readBlockScalar(kvLines, i, indent);
      parsed[key] = applyBlockStyle(block, style, chomp);
      i = nextIdx;
      continue;
    }

    // Plain scalar continuation: indented lines without `:` are appended with a space
    while (i < kvLines.length) {
      const next = kvLines[i];
      const nextTrimmed = next.trim();
      if (nextTrimmed === "" || nextTrimmed.startsWith("#")) break;
      const nextIndent = getIndent(next);
      if (nextIndent <= indent) break;
      value += ` ${nextTrimmed}`;
      i++;
    }

    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  const body = lines.slice(closingIdx + 1).join("\n");
  return { parsed, body };
}

/**
 * Extract just the body of a frontmatter document (everything after the closing `---`).
 * Returns the original content unchanged if no frontmatter is present.
 */
export function extractFrontmatterBody(content: string): string {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return content;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(i + 1).join("\n");
    }
  }
  return content;
}
