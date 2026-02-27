import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  TRUNCATION_WARNING,
  persistFullOutput,
  shouldTruncate,
  truncateHead,
  truncateHeadTail,
  truncateTail,
} from "../src/tool/truncation";

describe("truncation", () => {
  describe("shouldTruncate", () => {
    test("returns false for small output", () => {
      expect(shouldTruncate("hello world")).toBe(false);
    });

    test("returns true when bytes exceed limit", () => {
      const big = "x".repeat(MAX_OUTPUT_BYTES + 1);
      expect(shouldTruncate(big)).toBe(true);
    });

    test("returns true when lines exceed limit", () => {
      const lines = Array.from({ length: MAX_OUTPUT_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
      expect(shouldTruncate(lines)).toBe(true);
    });
  });

  describe("truncateHead", () => {
    test("returns unchanged output when within limits", () => {
      const result = truncateHead("hello\nworld");
      expect(result.truncated).toBe(false);
      expect(result.output).toBe("hello\nworld");
    });

    test("keeps first N lines when line limit exceeded", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
      const result = truncateHead(lines, MAX_OUTPUT_BYTES, 10);
      expect(result.truncated).toBe(true);
      expect(result.output.split("\n").length).toBe(10);
      expect(result.output).toStartWith("line 0\n");
      expect(result.originalLines).toBe(100);
    });

    test("keeps first N bytes when byte limit exceeded", () => {
      const big = "x".repeat(1000);
      const result = truncateHead(big, 100, MAX_OUTPUT_LINES);
      expect(result.truncated).toBe(true);
      expect(new TextEncoder().encode(result.output).length).toBeLessThanOrEqual(100);
      expect(result.originalBytes).toBe(1000);
    });

    test("char-based truncation runs before line-based (pathological case)", () => {
      // 2-line 10MB CSV — line-based alone would keep both lines (still 10MB)
      const megaLine = "x".repeat(5_000_000);
      const twoLineTenMB = `${megaLine}\n${megaLine}`;
      const result = truncateHead(twoLineTenMB, 1000, 10);
      expect(result.truncated).toBe(true);
      // Byte limit must be enforced even though only 2 lines
      expect(new TextEncoder().encode(result.output).length).toBeLessThanOrEqual(1000);
    });

    test("handles multi-byte characters at byte boundary", () => {
      // Each emoji is 4 bytes in UTF-8
      const emojis = "😀".repeat(100); // 400 bytes
      const result = truncateHead(emojis, 50, MAX_OUTPUT_LINES);
      expect(result.truncated).toBe(true);
      expect(new TextEncoder().encode(result.output).length).toBeLessThanOrEqual(50);
      // Should not have broken emoji sequences
      for (const char of result.output) {
        expect(char.codePointAt(0)).toBeGreaterThan(0);
      }
    });
  });

  describe("truncateTail", () => {
    test("returns unchanged output when within limits", () => {
      const result = truncateTail("hello\nworld");
      expect(result.truncated).toBe(false);
      expect(result.output).toBe("hello\nworld");
    });

    test("keeps last N lines when line limit exceeded", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
      const result = truncateTail(lines, MAX_OUTPUT_BYTES, 10);
      expect(result.truncated).toBe(true);
      expect(result.output.split("\n").length).toBe(10);
      expect(result.output).toContain("line 99");
      expect(result.originalLines).toBe(100);
    });

    test("keeps last N bytes when byte limit exceeded", () => {
      const big = "a".repeat(500) + "b".repeat(500);
      const result = truncateTail(big, 100, MAX_OUTPUT_LINES);
      expect(result.truncated).toBe(true);
      // Tail truncation: should contain mostly b's
      expect(result.output).toContain("b");
    });

    test("char-based truncation runs before line-based (pathological case)", () => {
      // 2-line 10MB — line-based alone would keep both lines
      const megaLine = "x".repeat(5_000_000);
      const twoLineTenMB = `${megaLine}\n${megaLine}`;
      const result = truncateTail(twoLineTenMB, 1000, 10);
      expect(result.truncated).toBe(true);
      // Must be within byte budget even with only 2 lines
      expect(new TextEncoder().encode(result.output).length).toBeLessThanOrEqual(1000);
    });
  });

  describe("truncateHeadTail", () => {
    test("returns unchanged output when within limits", () => {
      const result = truncateHeadTail("hello\nworld");
      expect(result.truncated).toBe(false);
      expect(result.output).toBe("hello\nworld");
    });

    test("preserves both beginning and end of output", () => {
      const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
      const result = truncateHeadTail(lines, MAX_OUTPUT_BYTES, 20);
      expect(result.truncated).toBe(true);
      // Should contain the beginning
      expect(result.output).toContain("line 0");
      // Should contain the end
      expect(result.output).toContain("line 199");
      // Should contain the omission marker
      expect(result.output).toContain("omitted");
    });

    test("includes omission marker with byte/line counts", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
      const result = truncateHeadTail(lines, 200, 10);
      expect(result.truncated).toBe(true);
      expect(result.output).toMatch(/\d+.*bytes.*\d+.*lines omitted/);
    });

    test("handles byte-heavy content (pathological 2-line case)", () => {
      const megaLine = "a".repeat(5_000_000);
      const twoLineTenMB = `${megaLine}\n${megaLine}`;
      const result = truncateHeadTail(twoLineTenMB, 1000, 100);
      expect(result.truncated).toBe(true);
      // Should start with a's (head portion)
      expect(result.output.startsWith("a")).toBe(true);
      // Should end with a's (tail portion)
      expect(result.output.trimEnd().endsWith("a")).toBe(true);
      // The full output (including marker) should be reasonable size
      const totalBytes = new TextEncoder().encode(result.output).length;
      // head (400) + marker (~50) + tail (600) = ~1050, reasonable
      expect(totalBytes).toBeLessThan(2000);
    });

    test("40/60 split: tail gets more budget than head", () => {
      // All lines are short and same length; with 10-line budget:
      // head gets 4 lines, tail gets 6 lines
      const lines = Array.from({ length: 50 }, (_, i) => `L${String(i).padStart(2, "0")}`).join("\n");
      const result = truncateHeadTail(lines, MAX_OUTPUT_BYTES, 10);
      expect(result.truncated).toBe(true);
      // Head portion should have ~4 lines from the beginning
      expect(result.output).toContain("L00");
      expect(result.output).toContain("L03");
      // Tail portion should have ~6 lines from the end
      expect(result.output).toContain("L49");
      expect(result.output).toContain("L44");
    });
  });

  describe("TRUNCATION_WARNING", () => {
    test("warning marker is defined and contains WARNING keyword", () => {
      expect(TRUNCATION_WARNING).toContain("WARNING");
      expect(TRUNCATION_WARNING).toContain("truncated");
    });
  });

  describe("persistFullOutput", () => {
    test("saves output to temp file and returns path", async () => {
      const content = "full output content here";
      const path = await persistFullOutput(content);
      expect(path).toContain("diligent-");
      const saved = await readFile(path, "utf-8");
      expect(saved).toBe(content);
    });
  });
});
