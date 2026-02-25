import { describe, expect, test } from "bun:test";
import { InputBuffer, Keys, matchesKey } from "../src/tui/input";

describe("matchesKey", () => {
  test("matches Enter", () => {
    expect(matchesKey(Buffer.from("\r"), Keys.ENTER)).toBe(true);
  });

  test("matches Ctrl+C", () => {
    expect(matchesKey(Buffer.from("\x03"), Keys.CTRL_C)).toBe(true);
  });

  test("matches Ctrl+D", () => {
    expect(matchesKey(Buffer.from("\x04"), Keys.CTRL_D)).toBe(true);
  });

  test("matches Backspace", () => {
    expect(matchesKey(Buffer.from("\x7f"), Keys.BACKSPACE)).toBe(true);
  });

  test("matches arrow keys", () => {
    expect(matchesKey(Buffer.from("\x1b[A"), Keys.UP)).toBe(true);
    expect(matchesKey(Buffer.from("\x1b[B"), Keys.DOWN)).toBe(true);
    expect(matchesKey(Buffer.from("\x1b[C"), Keys.RIGHT)).toBe(true);
    expect(matchesKey(Buffer.from("\x1b[D"), Keys.LEFT)).toBe(true);
  });

  test("does not match different keys", () => {
    expect(matchesKey(Buffer.from("a"), Keys.ENTER)).toBe(false);
    expect(matchesKey(Buffer.from("\r"), Keys.CTRL_C)).toBe(false);
  });

  test("works with string input", () => {
    expect(matchesKey("\r", Keys.ENTER)).toBe(true);
    expect(matchesKey("a", Keys.ENTER)).toBe(false);
  });
});

describe("InputBuffer", () => {
  test("insert characters", () => {
    const buf = new InputBuffer();
    buf.insert("h");
    buf.insert("i");
    expect(buf.text).toBe("hi");
    expect(buf.cursorPos).toBe(2);
  });

  test("backspace removes character", () => {
    const buf = new InputBuffer();
    buf.insert("abc");
    buf.backspace();
    expect(buf.text).toBe("ab");
    expect(buf.cursorPos).toBe(2);
  });

  test("backspace at start does nothing", () => {
    const buf = new InputBuffer();
    buf.backspace();
    expect(buf.text).toBe("");
    expect(buf.cursorPos).toBe(0);
  });

  test("clear returns text and resets", () => {
    const buf = new InputBuffer();
    buf.insert("hello");
    const text = buf.clear();
    expect(text).toBe("hello");
    expect(buf.text).toBe("");
    expect(buf.cursorPos).toBe(0);
  });

  test("moveLeft and moveRight", () => {
    const buf = new InputBuffer();
    buf.insert("abc");
    expect(buf.cursorPos).toBe(3);

    buf.moveLeft();
    expect(buf.cursorPos).toBe(2);

    buf.moveLeft();
    expect(buf.cursorPos).toBe(1);

    buf.moveRight();
    expect(buf.cursorPos).toBe(2);
  });

  test("moveLeft at start does nothing", () => {
    const buf = new InputBuffer();
    buf.moveLeft();
    expect(buf.cursorPos).toBe(0);
  });

  test("moveRight at end does nothing", () => {
    const buf = new InputBuffer();
    buf.insert("a");
    buf.moveRight();
    expect(buf.cursorPos).toBe(1);
  });

  test("insert at cursor position (middle)", () => {
    const buf = new InputBuffer();
    buf.insert("ac");
    buf.moveLeft();
    buf.insert("b");
    expect(buf.text).toBe("abc");
    expect(buf.cursorPos).toBe(2);
  });
});
