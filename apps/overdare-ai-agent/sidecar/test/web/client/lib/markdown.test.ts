// @summary Markdown HTML contracts for fenced code-block controls
import { expect, test } from "bun:test";
import { renderMarkdown } from "../../../../src/web/client/lib/markdown";

test("fenced code renders a language header and accessible copy control", () => {
  const html = renderMarkdown("```ts\nconst value = 1;\n```");

  expect(html).toContain('class="code-block"');
  expect(html).toContain('class="code-block__header"');
  expect(html).toContain('class="code-block__language">ts</span>');
  expect(html).toContain('data-code-copy-button="true"');
  expect(html).toContain('data-copied="false"');
  expect(html).toContain('aria-label="Copy ts code"');
  expect(html).toContain('class="language-ts"');
  expect(html).toContain("hljs-keyword");
});
