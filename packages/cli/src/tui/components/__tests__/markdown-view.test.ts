import { describe, expect, test } from "bun:test";
import { MarkdownView } from "../markdown-view";

describe("MarkdownView", () => {
  test("returns empty for no content", () => {
    const mv = new MarkdownView(() => {});
    expect(mv.render(80)).toEqual([]);
  });

  test("shows trailing buffer before newline, commits on newline", () => {
    const mv = new MarkdownView(() => {});
    mv.pushDelta("Hello ");
    // Trailing buffer is shown (better UX) but not yet committed via markdown rendering
    const beforeNewline = mv.render(80);
    expect(beforeNewline).toEqual(["Hello "]); // Raw trailing text

    mv.pushDelta("world\n");
    const afterNewline = mv.render(80);
    // Committed via markdown — "Hello world" visible
    expect(afterNewline.join("")).toContain("Hello");
    expect(afterNewline.join("")).toContain("world");
  });

  test("accumulates multiple deltas before newline", () => {
    const mv = new MarkdownView(() => {});
    mv.pushDelta("one ");
    mv.pushDelta("two ");
    mv.pushDelta("three\n");
    const lines = mv.render(80);
    expect(lines.length).toBeGreaterThan(0);
    // The rendered content should contain all three words
    const text = lines.join(" ");
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("three");
  });

  test("finalize renders remaining content", () => {
    const mv = new MarkdownView(() => {});
    mv.pushDelta("trailing text");
    mv.finalize();
    expect(mv.render(80).join("")).toContain("trailing text");
  });

  test("reset clears all state", () => {
    const mv = new MarkdownView(() => {});
    mv.pushDelta("hello\n");
    mv.reset();
    expect(mv.render(80)).toEqual([]);
  });

  test("handles multiple lines correctly", () => {
    const mv = new MarkdownView(() => {});
    mv.pushDelta("line 1\nline 2\n");
    const lines = mv.render(80);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const text = lines.join(" ");
    expect(text).toContain("line 1");
    expect(text).toContain("line 2");
  });

  test("requestRender is called on commit", () => {
    let renderCount = 0;
    const mv = new MarkdownView(() => {
      renderCount++;
    });
    mv.pushDelta("hello\n");
    expect(renderCount).toBe(1);
  });

  test("requestRender is called on finalize", () => {
    let renderCount = 0;
    const mv = new MarkdownView(() => {
      renderCount++;
    });
    mv.pushDelta("hello"); // no newline, but trailing timer
    mv.finalize();
    expect(renderCount).toBe(1);
  });

  test("trailing buffer shown in render before finalize", () => {
    const mv = new MarkdownView(() => {});
    mv.pushDelta("trailing");
    const lines = mv.render(80);
    // Should show trailing text even though no newline
    expect(lines[0]).toContain("trailing");
  });
});
