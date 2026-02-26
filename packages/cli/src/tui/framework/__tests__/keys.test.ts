import { describe, expect, test } from "bun:test";
import { isPrintable, matchesKey, parseKittyKey } from "../keys";

describe("matchesKey", () => {
  test("matches ctrl+c", () => {
    expect(matchesKey("\x03", "ctrl+c")).toBe(true);
  });

  test("matches ctrl+d", () => {
    expect(matchesKey("\x04", "ctrl+d")).toBe(true);
  });

  test("matches enter", () => {
    expect(matchesKey("\r", "enter")).toBe(true);
  });

  test("matches newline as enter", () => {
    expect(matchesKey("\n", "enter")).toBe(true);
  });

  test("matches escape", () => {
    expect(matchesKey("\x1b", "escape")).toBe(true);
  });

  test("matches tab", () => {
    expect(matchesKey("\t", "tab")).toBe(true);
  });

  test("matches backspace (DEL)", () => {
    expect(matchesKey("\x7f", "backspace")).toBe(true);
  });

  test("matches backspace (BS)", () => {
    expect(matchesKey("\b", "backspace")).toBe(true);
  });

  test("matches arrow up (legacy)", () => {
    expect(matchesKey("\x1b[A", "up")).toBe(true);
  });

  test("matches arrow down (legacy)", () => {
    expect(matchesKey("\x1b[B", "down")).toBe(true);
  });

  test("matches arrow right (legacy)", () => {
    expect(matchesKey("\x1b[C", "right")).toBe(true);
  });

  test("matches arrow left (legacy)", () => {
    expect(matchesKey("\x1b[D", "left")).toBe(true);
  });

  test("matches arrow up (SS3)", () => {
    expect(matchesKey("\x1bOA", "up")).toBe(true);
  });

  test("matches home", () => {
    expect(matchesKey("\x1b[H", "home")).toBe(true);
  });

  test("matches end", () => {
    expect(matchesKey("\x1b[F", "end")).toBe(true);
  });

  test("matches delete", () => {
    expect(matchesKey("\x1b[3~", "delete")).toBe(true);
  });

  test("matches ctrl+a", () => {
    expect(matchesKey("\x01", "ctrl+a")).toBe(true);
  });

  test("matches ctrl+e", () => {
    expect(matchesKey("\x05", "ctrl+e")).toBe(true);
  });

  test("matches ctrl+k", () => {
    expect(matchesKey("\x0b", "ctrl+k")).toBe(true);
  });

  test("matches ctrl+u", () => {
    expect(matchesKey("\x15", "ctrl+u")).toBe(true);
  });

  test("matches ctrl+w", () => {
    expect(matchesKey("\x17", "ctrl+w")).toBe(true);
  });

  test("does not match wrong key", () => {
    expect(matchesKey("\x03", "ctrl+d")).toBe(false);
    expect(matchesKey("a", "enter")).toBe(false);
    expect(matchesKey("\x1b[A", "down")).toBe(false);
  });

  test("matches shift+enter (Kitty)", () => {
    expect(matchesKey("\x1b[13;2u", "shift+enter")).toBe(true);
  });
});

describe("parseKittyKey", () => {
  test("parses basic Kitty key", () => {
    const result = parseKittyKey("\x1b[13u");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("enter");
    expect(result!.modifiers).toBe(0);
    expect(result!.eventType).toBe(1);
  });

  test("parses Kitty key with modifier", () => {
    const result = parseKittyKey("\x1b[13;2u");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("enter");
    expect(result!.modifiers).toBe(1); // Shift (2-1=1)
    expect(result!.eventType).toBe(1);
  });

  test("parses Kitty key with event type", () => {
    const result = parseKittyKey("\x1b[97;1:3u");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("a");
    expect(result!.modifiers).toBe(0);
    expect(result!.eventType).toBe(3); // release
  });

  test("returns null for non-Kitty sequence", () => {
    expect(parseKittyKey("\x1b[A")).toBeNull();
    expect(parseKittyKey("a")).toBeNull();
    expect(parseKittyKey("\x03")).toBeNull();
  });
});

describe("isPrintable", () => {
  test("returns true for printable characters", () => {
    expect(isPrintable("a")).toBe(true);
    expect(isPrintable("Z")).toBe(true);
    expect(isPrintable("0")).toBe(true);
    expect(isPrintable(" ")).toBe(true);
    expect(isPrintable("~")).toBe(true);
  });

  test("returns false for control characters", () => {
    expect(isPrintable("\x03")).toBe(false);
    expect(isPrintable("\x1b")).toBe(false);
    expect(isPrintable("\x7f")).toBe(false);
    expect(isPrintable("\r")).toBe(false);
    expect(isPrintable("\n")).toBe(false);
  });

  test("returns false for multi-character strings", () => {
    expect(isPrintable("ab")).toBe(false);
    expect(isPrintable("\x1b[A")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isPrintable("")).toBe(false);
  });
});
