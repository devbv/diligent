import { describe, test, expect } from "bun:test";
import { renderMarkdown } from "../src/tui/markdown";

describe("renderMarkdown", () => {
  test("renders bold text with ANSI", () => {
    const result = renderMarkdown("**bold text**", 80);
    expect(result).toContain("\x1b[1m");
    expect(result).toContain("bold text");
    expect(result).toContain("\x1b[22m");
  });

  test("renders italic text with ANSI", () => {
    const result = renderMarkdown("*italic text*", 80);
    expect(result).toContain("\x1b[3m");
    expect(result).toContain("italic text");
    expect(result).toContain("\x1b[23m");
  });

  test("renders inline code with cyan", () => {
    const result = renderMarkdown("`some code`", 80);
    expect(result).toContain("\x1b[36m");
    expect(result).toContain("some code");
  });

  test("renders code blocks with indentation", () => {
    const result = renderMarkdown("```ts\nconst x = 1;\n```", 80);
    expect(result).toContain("const x = 1");
    expect(result).toContain("[ts]");
  });

  test("renders headers with bold+underline", () => {
    const result = renderMarkdown("# Header", 80);
    expect(result).toContain("\x1b[1m");
    expect(result).toContain("\x1b[4m");
    expect(result).toContain("Header");
  });

  test("renders lists with bullets", () => {
    const result = renderMarkdown("- item one\n- item two", 80);
    expect(result).toContain("•");
    expect(result).toContain("item one");
    expect(result).toContain("item two");
  });

  test("renders links with URL", () => {
    const result = renderMarkdown("[click here](https://example.com)", 80);
    expect(result).toContain("click here");
    expect(result).toContain("https://example.com");
  });

  test("handles plain text without errors", () => {
    const result = renderMarkdown("just plain text", 80);
    expect(result).toContain("just plain text");
  });

  test("handles partial/incomplete markdown gracefully", () => {
    const result = renderMarkdown("**unclosed bold", 80);
    // Should not throw, should contain the text
    expect(result).toContain("unclosed bold");
  });

  test("handles empty string", () => {
    const result = renderMarkdown("", 80);
    expect(result).toBe("");
  });
});
