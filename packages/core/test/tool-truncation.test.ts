import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  persistFullOutput,
  shouldTruncate,
  truncateHead,
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
