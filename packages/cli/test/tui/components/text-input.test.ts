// @summary Tests for text input component and user interactions
import { describe, expect, mock, test } from "bun:test";
import { TextInput, type TextInputOptions } from "../../../src/tui/components/text-input";

function createInput(opts?: Partial<TextInputOptions>, onResult?: (v: string | null) => void) {
  const callback = onResult ?? mock(() => {});
  const input = new TextInput({ title: "Test Input", ...opts }, callback);
  return { input, callback };
}

// Strip ANSI escape codes for easier assertions
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

describe("TextInput", () => {
  test("renders title in border", () => {
    const { input } = createInput({ title: "API Key" });
    const lines = input.render(60);
    const plain = lines.map(stripAnsi);
    expect(plain[0]).toContain("API Key");
  });

  test("renders message when provided", () => {
    const { input } = createInput({ title: "Key", message: "Enter your key" });
    const lines = input.render(60);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("Enter your key");
  });

  test("renders placeholder when empty", () => {
    const { input } = createInput({ title: "Key", placeholder: "sk-..." });
    const lines = input.render(60);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("sk-...");
  });

  test("typing characters updates value", () => {
    const { input } = createInput();
    input.handleInput("a");
    input.handleInput("b");
    input.handleInput("c");
    expect(input.getValue()).toBe("abc");
  });

  test("bracketed paste inserts full value", () => {
    const { input } = createInput();
    input.handleInput("\x1b[200~sk-test-key\x1b[201~");
    expect(input.getValue()).toBe("sk-test-key");
  });

  test("bracketed paste inserts at cursor", () => {
    const { input } = createInput();
    input.handleInput("a");
    input.handleInput("c");
    input.handleInput("\x1b[D");
    input.handleInput("\x1b[200~b\x1b[201~");
    expect(input.getValue()).toBe("abc");
  });

  test("backspace deletes character", () => {
    const { input } = createInput();
    input.handleInput("a");
    input.handleInput("b");
    input.handleInput("\x7f"); // backspace
    expect(input.getValue()).toBe("a");
  });

  test("ctrl+u clears entire line", () => {
    const { input } = createInput();
    input.handleInput("h");
    input.handleInput("e");
    input.handleInput("l");
    input.handleInput("\x15"); // ctrl+u
    expect(input.getValue()).toBe("");
  });

  test("ctrl+a moves to start, ctrl+e to end", () => {
    const { input } = createInput();
    input.handleInput("a");
    input.handleInput("b");
    input.handleInput("c");
    // Move to start
    input.handleInput("\x01"); // ctrl+a
    // Type at start
    input.handleInput("x");
    expect(input.getValue()).toBe("xabc");

    // Move to end
    input.handleInput("\x05"); // ctrl+e
    input.handleInput("z");
    expect(input.getValue()).toBe("xabcz");
  });

  test("left/right arrow cursor movement", () => {
    const { input } = createInput();
    input.handleInput("a");
    input.handleInput("b");
    input.handleInput("c");
    input.handleInput("\x1b[D"); // left
    input.handleInput("\x1b[D"); // left
    input.handleInput("x");
    expect(input.getValue()).toBe("axbc");
  });

  test("enter submits the value", () => {
    const cb = mock((_v: string | null) => {});
    const { input } = createInput({}, cb);
    input.handleInput("t");
    input.handleInput("e");
    input.handleInput("s");
    input.handleInput("t");
    input.handleInput("\r"); // enter
    expect(cb).toHaveBeenCalledWith("test");
  });

  test("enter on empty input returns null", () => {
    const cb = mock((_v: string | null) => {});
    const { input } = createInput({}, cb);
    input.handleInput("\r"); // enter
    expect(cb).toHaveBeenCalledWith(null);
  });

  test("escape cancels and returns null", () => {
    const cb = mock((_v: string | null) => {});
    const { input } = createInput({}, cb);
    input.handleInput("a");
    input.handleInput("b");
    input.handleInput("\x1b"); // escape
    expect(cb).toHaveBeenCalledWith(null);
  });

  test("ctrl+c cancels and returns null", () => {
    const cb = mock((_v: string | null) => {});
    const { input } = createInput({}, cb);
    input.handleInput("a");
    input.handleInput("\x03"); // ctrl+c
    expect(cb).toHaveBeenCalledWith(null);
  });

  test("masked mode renders bullets instead of text", () => {
    const { input } = createInput({ title: "Key", masked: true });
    input.handleInput("s");
    input.handleInput("e");
    input.handleInput("c");
    input.handleInput("r");
    input.handleInput("e");
    input.handleInput("t");

    const lines = input.render(60);
    const plain = lines.map(stripAnsi).join("\n");
    // Should contain bullet characters, not the actual text
    expect(plain).toContain("\u2022");
    expect(plain).not.toContain("secret");
  });

  test("ctrl+k deletes from cursor to end", () => {
    const { input } = createInput();
    input.handleInput("a");
    input.handleInput("b");
    input.handleInput("c");
    input.handleInput("d");
    // Move cursor to position 2
    input.handleInput("\x1b[D"); // left
    input.handleInput("\x1b[D"); // left
    input.handleInput("\x0b"); // ctrl+k
    expect(input.getValue()).toBe("ab");
  });

  test("delete key removes character at cursor", () => {
    const { input } = createInput();
    input.handleInput("a");
    input.handleInput("b");
    input.handleInput("c");
    // Move to start
    input.handleInput("\x01"); // ctrl+a
    input.handleInput("\x1b[3~"); // delete
    expect(input.getValue()).toBe("bc");
  });

  test("render includes hint line", () => {
    const { input } = createInput();
    const lines = input.render(60);
    const plain = lines.map(stripAnsi).join("\n");
    expect(plain).toContain("Enter to submit");
    expect(plain).toContain("Escape to cancel");
  });

  test("invalidate does not throw", () => {
    const { input } = createInput();
    expect(() => input.invalidate()).not.toThrow();
  });
});
