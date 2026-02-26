import { describe, expect, test } from "bun:test";
import { StdinBuffer } from "../stdin-buffer";

describe("StdinBuffer", () => {
  const buf = new StdinBuffer();

  test("splits single characters", () => {
    expect(buf.split("abc")).toEqual(["a", "b", "c"]);
  });

  test("splits escape sequences", () => {
    expect(buf.split("\x1b[A\x1b[B")).toEqual(["\x1b[A", "\x1b[B"]);
  });

  test("splits mixed input", () => {
    expect(buf.split("a\x1b[Ab")).toEqual(["a", "\x1b[A", "b"]);
  });

  test("handles control characters", () => {
    expect(buf.split("\x03\x04")).toEqual(["\x03", "\x04"]);
  });

  test("handles empty input", () => {
    expect(buf.split("")).toEqual([]);
  });

  test("handles single character", () => {
    expect(buf.split("x")).toEqual(["x"]);
  });

  test("handles SS3 sequences (ESC O)", () => {
    expect(buf.split("\x1bOA\x1bOB")).toEqual(["\x1bOA", "\x1bOB"]);
  });

  test("handles CSI sequences with parameters", () => {
    expect(buf.split("\x1b[1;2A")).toEqual(["\x1b[1;2A"]);
  });

  test("handles Kitty protocol sequences", () => {
    expect(buf.split("\x1b[13;2u")).toEqual(["\x1b[13;2u"]);
  });

  test("handles Alt+key (ESC + char)", () => {
    expect(buf.split("\x1ba")).toEqual(["\x1ba"]);
  });

  test("handles delete key sequence", () => {
    expect(buf.split("\x1b[3~")).toEqual(["\x1b[3~"]);
  });

  test("handles lone escape at end of input", () => {
    expect(buf.split("a\x1b")).toEqual(["a", "\x1b"]);
  });

  test("handles complex mixed input", () => {
    const input = "hello\x1b[A\x03world\x1b[B";
    const result = buf.split(input);
    expect(result).toEqual(["h", "e", "l", "l", "o", "\x1b[A", "\x03", "w", "o", "r", "l", "d", "\x1b[B"]);
  });
});
