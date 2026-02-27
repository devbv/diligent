import { Marked, Renderer } from "marked";
import { t } from "./theme";

/**
 * Custom marked renderer that outputs ANSI-styled terminal text. (D047)
 * Uses marked v17 API where renderer methods receive token objects
 * and use this.parser.parseInline() for inline content.
 */
const renderer = new Renderer();

renderer.heading = function (token) {
  const text = this.parser.parseInline(token.tokens);
  return `\n${t.bold}${t.underline}${text}${t.underlineOff}${t.boldOff}\n\n`;
};

renderer.paragraph = function (token) {
  const text = this.parser.parseInline(token.tokens);
  return `${text}\n\n`;
};

renderer.strong = function (token) {
  const text = this.parser.parseInline(token.tokens);
  return `${t.bold}${text}${t.boldOff}`;
};

renderer.em = function (token) {
  const text = this.parser.parseInline(token.tokens);
  return `${t.italic}${text}${t.italicOff}`;
};

renderer.codespan = (token) => `${t.accent}${token.text}${t.reset}`;

renderer.code = (token) => {
  const header = token.lang ? `${t.dim}[${token.lang}]${t.reset}\n` : "";
  const indented = token.text
    .split("\n")
    .map((line: string) => `  ${line}`)
    .join("\n");
  return `\n${header}${t.accent}${indented}${t.reset}\n\n`;
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
  if (text === token.href) return `${t.accent}${token.href}${t.reset}`;
  return `${text} (${t.accent}${token.href}${t.reset})`;
};

renderer.blockquote = function (token) {
  const text = this.parser.parse(token.tokens);
  const lines = text
    .trim()
    .split("\n")
    .map((line: string) => `${t.dim}│ ${line}${t.reset}`)
    .join("\n");
  return `${lines}\n\n`;
};

renderer.hr = () => `\n${"─".repeat(40)}\n\n`;

renderer.br = () => "\n";

renderer.del = function (token) {
  const text = this.parser.parseInline(token.tokens);
  return `~~${text}~~`;
};

renderer.html = (token) => token.text;

renderer.text = (token) => token.text;

renderer.space = () => "";

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
