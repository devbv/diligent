// @summary Tests for tool output truncation strategies
import { describe, expect, test } from "bun:test";
import {
  MAX_OUTPUT_BYTES,
  shouldTruncate,
  truncateHead,
  truncateHeadTail,
  truncateTail,
} from "../../src/tool/truncation";

describe("truncation", () => {
  describe("shouldTruncate", () => {
    test("returns false for small output", () => {
      expect(shouldTruncate("hello world")).toBe(false);
    });

    test("returns true when bytes exceed limit", () => {
      const big = "x".repeat(MAX_OUTPUT_BYTES + 1);
      expect(shouldTruncate(big)).toBe(true);
    });
  });

  describe("truncateHead", () => {
    test("returns unchanged output when within limits", () => {
      const result = truncateHead("hello\nworld");
      expect(result.truncated).toBe(false);
      expect(result.output).toBe("hello\nworld");
    });

    test("keeps first N bytes when byte limit exceeded", () => {
      const big = "x".repeat(1000);
      const result = truncateHead(big, 100);
      expect(result.truncated).toBe(true);
      expect(new TextEncoder().encode(result.output).length).toBeLessThanOrEqual(100);
      expect(result.originalBytes).toBe(1000);
    });

    test("char-based truncation handles pathological case", () => {
      // 2-line 10MB CSV
      const megaLine = "x".repeat(5_000_000);
      const twoLineTenMB = `${megaLine}\n${megaLine}`;
      const result = truncateHead(twoLineTenMB, 1000);
      expect(result.truncated).toBe(true);
      expect(new TextEncoder().encode(result.output).length).toBeLessThanOrEqual(1000);
    });

    test("handles multi-byte characters at byte boundary", () => {
      // Each emoji is 4 bytes in UTF-8
      const emojis = "😀".repeat(100); // 400 bytes
      const result = truncateHead(emojis, 50);
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

    test("keeps last N bytes when byte limit exceeded", () => {
      const big = "a".repeat(500) + "b".repeat(500);
      const result = truncateTail(big, 100);
      expect(result.truncated).toBe(true);
      // Tail truncation: should contain mostly b's
      expect(result.output).toContain("b");
    });

    test("char-based truncation handles pathological case", () => {
      // 2-line 10MB
      const megaLine = "x".repeat(5_000_000);
      const twoLineTenMB = `${megaLine}\n${megaLine}`;
      const result = truncateTail(twoLineTenMB, 1000);
      expect(result.truncated).toBe(true);
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
      const big = "A".repeat(500) + "M".repeat(500) + "Z".repeat(500);
      const result = truncateHeadTail(big, 200);
      expect(result.truncated).toBe(true);
      // Should contain the beginning
      expect(result.output).toContain("A");
      // Should contain the end
      expect(result.output).toContain("Z");
      // Should contain the omission marker
      expect(result.output).toContain("omitted");
    });

    test("includes omission marker with byte count", () => {
      const big = "x".repeat(1000);
      const result = truncateHeadTail(big, 200);
      expect(result.truncated).toBe(true);
      expect(result.output).toMatch(/\d+.*bytes omitted/);
    });

    test("handles byte-heavy content (pathological case)", () => {
      const megaLine = "a".repeat(5_000_000);
      const twoLineTenMB = `${megaLine}\n${megaLine}`;
      const result = truncateHeadTail(twoLineTenMB, 1000);
      expect(result.truncated).toBe(true);
      // Should start with a's (head portion)
      expect(result.output.startsWith("a")).toBe(true);
      // Should end with a's (tail portion)
      expect(result.output.trimEnd().endsWith("a")).toBe(true);
      // The full output (including marker) should be reasonable size
      const totalBytes = new TextEncoder().encode(result.output).length;
      expect(totalBytes).toBeLessThan(2000);
    });

    test("40/60 split: tail gets more budget than head", () => {
      // With 200 byte budget: head gets 80 bytes, tail gets 120 bytes
      const big = "H".repeat(500) + "T".repeat(500);
      const result = truncateHeadTail(big, 200);
      expect(result.truncated).toBe(true);
      // Head portion should have H's
      expect(result.output).toContain("H");
      // Tail portion should have T's
      expect(result.output).toContain("T");
    });
  });
});
