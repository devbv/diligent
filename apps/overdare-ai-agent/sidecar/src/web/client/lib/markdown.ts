// @summary Marked wrapper with highlight.js syntax highlighting for code blocks
import hljs from "highlight.js";
import { marked } from "marked";
import { markedHighlight } from "marked-highlight";

const renderer = new marked.Renderer();

renderer.link = ({ href, title, tokens, text }) => {
  const safeHref = href ?? "#";
  const titleAttr = title ? ` title="${title}"` : "";
  const label = text || marked.Parser.parseInline(tokens ?? []);
  return `<a href="${safeHref}"${titleAttr} class="prose-link" target="_blank" rel="noopener noreferrer">${label}</a>`;
};

marked.use(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  }),
);

marked.setOptions({
  breaks: false,
  gfm: true,
  renderer,
});

export function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}

export function renderInlineMarkdown(text: string): string {
  return marked.parseInline(text) as string;
}
