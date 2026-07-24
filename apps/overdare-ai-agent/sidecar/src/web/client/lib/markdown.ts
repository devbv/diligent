// @summary Marked wrapper with highlight.js syntax highlighting for code blocks
import hljs from "highlight.js";
import { marked } from "marked";
import { markedHighlight } from "marked-highlight";

const renderer = new marked.Renderer();

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function normalizeCodeLanguage(lang: string | undefined): string {
  return lang?.trim().split(/\s+/, 1)[0] || "text";
}

renderer.link = ({ href, title, tokens, text }) => {
  const safeHref = href ?? "#";
  const titleAttr = title ? ` title="${title}"` : "";
  const label = text || marked.Parser.parseInline(tokens ?? []);
  return `<a href="${safeHref}"${titleAttr} class="prose-link" target="_blank" rel="noopener noreferrer">${label}</a>`;
};

renderer.code = ({ text, lang, escaped }) => {
  const language = normalizeCodeLanguage(lang);
  const escapedLanguage = escapeHtml(language);
  const languageClass = language.replace(/[^a-zA-Z0-9_+-]/g, "-");
  const renderedCode = escaped ? text.replace(/\n$/, "") : escapeHtml(text.replace(/\n$/, ""));
  const copyLabel = `Copy ${escapedLanguage} code`;

  return [
    '<div class="code-block">',
    '<div class="code-block__header">',
    `<span class="code-block__language">${escapedLanguage}</span>`,
    `<button type="button" class="code-block__copy-button" data-code-copy-button="true" data-copied="false" data-copy-label="${copyLabel}" aria-label="${copyLabel}" title="Copy code">`,
    '<svg class="code-block__copy-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">',
    '<rect x="5.25" y="2.75" width="7.5" height="8.5" rx="1.25" stroke="currentColor" stroke-width="1.5"/>',
    '<path d="M3.75 5.25H3.5C2.81 5.25 2.25 5.81 2.25 6.5v6c0 .69.56 1.25 1.25 1.25h5c.69 0 1.25-.56 1.25-1.25v-.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    "</svg>",
    '<svg class="code-block__check-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">',
    '<path d="m3.25 8.25 3 3 6.5-6.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    "</svg>",
    "</button>",
    "</div>",
    `<pre><code class="language-${languageClass}">${renderedCode}</code></pre>`,
    "</div>\n",
  ].join("");
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
