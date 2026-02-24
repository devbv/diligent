import { Marked, Renderer } from "marked";

// ANSI escape codes
const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const ITALIC_ON = "\x1b[3m";
const ITALIC_OFF = "\x1b[23m";
const UNDERLINE_ON = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Custom marked renderer that outputs ANSI-styled terminal text. (D047)
 * Uses marked v17 API where renderer methods receive token objects
 * and use this.parser.parseInline() for inline content.
 */
const renderer = new Renderer();

renderer.heading = function (token) {
  const text = this.parser.parseInline(token.tokens);
  return `\n${BOLD_ON}${UNDERLINE_ON}${text}${UNDERLINE_OFF}${BOLD_OFF}\n\n`;
};

renderer.paragraph = function (token) {
  const text = this.parser.parseInline(token.tokens);
  return `${text}\n\n`;
};

renderer.strong = function (token) {
  const text = this.parser.parseInline(token.tokens);
  return `${BOLD_ON}${text}${BOLD_OFF}`;
};

renderer.em = function (token) {
  const text = this.parser.parseInline(token.tokens);
  return `${ITALIC_ON}${text}${ITALIC_OFF}`;
};

renderer.codespan = function (token) {
  return `${CYAN}${token.text}${RESET}`;
};

renderer.code = function (token) {
  const header = token.lang ? `${GRAY}[${token.lang}]${RESET}\n` : "";
  const indented = token.text.split("\n").map((line: string) => `  ${line}`).join("\n");
  return `\n${header}${CYAN}${indented}${RESET}\n\n`;
};

renderer.list = function (token) {
  let body = "";
  for (const item of token.items) {
    body += this.listitem(item);
  }
  return `${body}\n`;
};

renderer.listitem = function (token) {
  const text = this.parser.parseInline(token.tokens);
  const cleaned = text.replace(/\n\n$/, "").replace(/\n$/, "");
  return `  • ${cleaned}\n`;
};

renderer.link = function (token) {
  const text = this.parser.parseInline(token.tokens);
  if (text === token.href) return `${CYAN}${token.href}${RESET}`;
  return `${text} (${CYAN}${token.href}${RESET})`;
};

renderer.blockquote = function (token) {
  const text = this.parser.parse(token.tokens);
  const lines = text.trim().split("\n").map((line: string) => `${GRAY}│ ${line}${RESET}`).join("\n");
  return `${lines}\n\n`;
};

renderer.hr = function () {
  return `\n${"─".repeat(40)}\n\n`;
};

renderer.br = function () {
  return "\n";
};

renderer.del = function (token) {
  const text = this.parser.parseInline(token.tokens);
  return `~~${text}~~`;
};

renderer.html = function (token) {
  return token.text;
};

renderer.text = function (token) {
  return token.text;
};

renderer.space = function () {
  return "";
};

const marked = new Marked({ renderer, async: false });

/**
 * Render markdown text as ANSI-styled terminal output.
 */
export function renderMarkdown(text: string, _width: number): string {
  try {
    const result = marked.parse(text) as string;
    // Clean up excessive newlines
    return result.replace(/\n{3,}/g, "\n\n").trimEnd();
  } catch {
    // Fallback: return raw text if parsing fails
    return text;
  }
}
