import { describe, expect, test } from "bun:test";
import type { CompletionItem } from "../../commands/registry";
import { CURSOR_MARKER } from "../../framework/types";
import { InputEditor } from "../input-editor";

describe("InputEditor", () => {
  function create(opts?: {
    onSubmit?: (text: string) => void;
    onCancel?: () => void;
    onExit?: () => void;
    onCompleteDetailed?: (partial: string) => CompletionItem[];
  }) {
    const renderCalls: number[] = [];
    const editor = new InputEditor({ prompt: "> ", ...opts }, () => renderCalls.push(1));
    editor.focused = true;
    return { editor, renderCalls };
  }

  test("renders empty input with cursor", () => {
    const { editor } = create();
    const lines = editor.render(80);
    expect(lines).toHaveLength(4); // blank + top separator + input line + bottom separator
    expect(lines[2]).toContain(">");
    expect(lines[2]).toContain(CURSOR_MARKER);
  });

  test("inserts printable characters", () => {
    const { editor } = create();
    editor.handleInput("h");
    editor.handleInput("i");
    expect(editor.getText()).toBe("hi");
  });

  test("handles backspace", () => {
    const { editor } = create();
    editor.handleInput("a");
    editor.handleInput("b");
    editor.handleInput("\x7f"); // backspace
    expect(editor.getText()).toBe("a");
  });

  test("handles backspace at start (no-op)", () => {
    const { editor } = create();
    editor.handleInput("\x7f");
    expect(editor.getText()).toBe("");
  });

  test("cursor movement left/right", () => {
    const { editor } = create();
    editor.handleInput("a");
    editor.handleInput("b");
    editor.handleInput("c");
    editor.handleInput("\x1b[D"); // left
    editor.handleInput("X");
    expect(editor.getText()).toBe("abXc");
  });

  test("ctrl+a moves to start", () => {
    const { editor } = create();
    editor.setText("hello");
    editor.handleInput("\x01"); // ctrl+a
    editor.handleInput("X");
    expect(editor.getText()).toBe("Xhello");
  });

  test("ctrl+e moves to end", () => {
    const { editor } = create();
    editor.setText("hello");
    editor.handleInput("\x01"); // ctrl+a (go to start)
    editor.handleInput("\x05"); // ctrl+e (go to end)
    editor.handleInput("X");
    expect(editor.getText()).toBe("helloX");
  });

  test("ctrl+k deletes to end", () => {
    const { editor } = create();
    editor.setText("hello world");
    // Move cursor to position 5
    editor.handleInput("\x01"); // start
    for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // right x5
    editor.handleInput("\x0b"); // ctrl+k
    expect(editor.getText()).toBe("hello");
  });

  test("ctrl+u deletes to start", () => {
    const { editor } = create();
    editor.setText("hello world");
    // cursor is at end
    editor.handleInput("\x1b[D"); // left (at position 10: before 'd')
    editor.handleInput("\x15"); // ctrl+u
    expect(editor.getText()).toBe("d");
  });

  test("ctrl+w deletes word backward", () => {
    const { editor } = create();
    editor.setText("hello world");
    editor.handleInput("\x17"); // ctrl+w
    expect(editor.getText()).toBe("hello ");
  });

  test("delete key removes char at cursor", () => {
    const { editor } = create();
    editor.setText("abc");
    editor.handleInput("\x01"); // go to start
    editor.handleInput("\x1b[3~"); // delete
    expect(editor.getText()).toBe("bc");
  });

  test("enter submits text", () => {
    const submitted: string[] = [];
    const { editor } = create({ onSubmit: (t) => submitted.push(t) });
    editor.handleInput("h");
    editor.handleInput("i");
    editor.handleInput("\r"); // enter
    expect(submitted).toEqual(["hi"]);
    expect(editor.getText()).toBe("");
  });

  test("enter does nothing for empty input", () => {
    const submitted: string[] = [];
    const { editor } = create({ onSubmit: (t) => submitted.push(t) });
    editor.handleInput("\r");
    expect(submitted).toEqual([]);
  });

  test("ctrl+c calls onCancel", () => {
    let cancelled = false;
    const { editor } = create({
      onCancel: () => {
        cancelled = true;
      },
    });
    editor.handleInput("\x03");
    expect(cancelled).toBe(true);
  });

  test("ctrl+d calls onExit when input empty", () => {
    let exited = false;
    const { editor } = create({
      onExit: () => {
        exited = true;
      },
    });
    editor.handleInput("\x04");
    expect(exited).toBe(true);
  });

  test("ctrl+d does nothing when input has text", () => {
    let exited = false;
    const { editor } = create({
      onExit: () => {
        exited = true;
      },
    });
    editor.handleInput("x");
    editor.handleInput("\x04");
    expect(exited).toBe(false);
  });

  test("history navigation with up/down", () => {
    const { editor } = create({ onSubmit: () => {} });
    editor.handleInput("f");
    editor.handleInput("i");
    editor.handleInput("r");
    editor.handleInput("s");
    editor.handleInput("t");
    editor.handleInput("\r"); // submit "first"

    editor.handleInput("s");
    editor.handleInput("e");
    editor.handleInput("c");
    editor.handleInput("o");
    editor.handleInput("n");
    editor.handleInput("d");
    editor.handleInput("\r"); // submit "second"

    editor.handleInput("\x1b[A"); // up
    expect(editor.getText()).toBe("second");

    editor.handleInput("\x1b[A"); // up
    expect(editor.getText()).toBe("first");

    editor.handleInput("\x1b[B"); // down
    expect(editor.getText()).toBe("second");

    editor.handleInput("\x1b[B"); // down (back to draft)
    expect(editor.getText()).toBe("");
  });

  test("up/down returns false when input has text and not in history mode", () => {
    const { editor } = create({ onSubmit: () => {} });
    editor.handleInput("h");
    editor.handleInput("i");
    // cursor at end, not in history mode → guard fails → not consumed
    expect(editor.handleInput("\x1b[A")).toBe(false);
    expect(editor.handleInput("\x1b[B")).toBe(false);
    expect(editor.getText()).toBe("hi"); // text unchanged
  });

  test("up returns true and navigates when input is empty", () => {
    const { editor } = create({ onSubmit: () => {} });
    editor.handleInput("f");
    editor.handleInput("o");
    editor.handleInput("o");
    editor.handleInput("\r"); // submit "foo"
    expect(editor.handleInput("\x1b[A")).toBe(true);
    expect(editor.getText()).toBe("foo");
  });

  test("clear resets text and cursor", () => {
    const { editor } = create();
    editor.handleInput("h");
    editor.handleInput("i");
    editor.clear();
    expect(editor.getText()).toBe("");
  });

  test("setText sets text and moves cursor to end", () => {
    const { editor } = create();
    editor.setText("hello");
    expect(editor.getText()).toBe("hello");
    editor.handleInput("!");
    expect(editor.getText()).toBe("hello!");
  });

  describe("completion popup", () => {
    const mockItems: CompletionItem[] = [
      { name: "help", description: "Show help" },
      { name: "history", description: "Show history" },
      { name: "model", description: "Change model" },
    ];

    function createWithCompletion(opts?: { onSubmit?: (text: string) => void }) {
      return create({
        ...opts,
        onCompleteDetailed: (partial: string) => mockItems.filter((item) => item.name.startsWith(partial)),
      });
    }

    test("popup appears when typing /", () => {
      const { editor } = createWithCompletion();
      editor.handleInput("/");
      const lines = editor.render(80);
      // base 4 lines + 3 popup items
      expect(lines).toHaveLength(7);
    });

    test("popup filters as more characters are typed", () => {
      const { editor } = createWithCompletion();
      editor.handleInput("/");
      editor.handleInput("h");
      const lines = editor.render(80);
      // base 4 + 2 items (help, history)
      expect(lines).toHaveLength(6);
    });

    test("up/down navigates selection index", () => {
      const { editor } = createWithCompletion();
      editor.handleInput("/");
      // Layout: blank, sep, input, sep, popup items...
      // Initially selected index is 0
      let lines = editor.render(80);
      expect(lines[4]).toContain("\u25b8"); // first item selected
      expect(lines[4]).toContain("help");

      editor.handleInput("\x1b[B"); // down
      lines = editor.render(80);
      expect(lines[5]).toContain("\u25b8"); // second item selected
      expect(lines[5]).toContain("history");
    });

    test("tab accepts completion and fills text with trailing space", () => {
      const { editor } = createWithCompletion();
      editor.handleInput("/");
      editor.handleInput("\x1b[B"); // select "history"
      editor.handleInput("\t"); // tab
      expect(editor.getText()).toBe("/history ");
    });

    test("enter accepts completion and submits", () => {
      const submitted: string[] = [];
      const { editor } = createWithCompletion({ onSubmit: (t) => submitted.push(t) });
      editor.handleInput("/");
      editor.handleInput("\x1b[B"); // select "history"
      editor.handleInput("\r"); // enter
      expect(submitted).toEqual(["/history"]);
      expect(editor.getText()).toBe("");
    });

    test("escape closes popup and keeps text", () => {
      const { editor } = createWithCompletion();
      editor.handleInput("/");
      editor.handleInput("h");
      editor.handleInput("\x1b"); // escape
      expect(editor.getText()).toBe("/h");
      const lines = editor.render(80);
      // base 4 lines, no popup
      expect(lines).toHaveLength(4);
    });

    test("popup hidden when text does not start with /", () => {
      const { editor } = createWithCompletion();
      editor.handleInput("h");
      const lines = editor.render(80);
      expect(lines).toHaveLength(4);
    });

    test("popup hidden after space in input", () => {
      const { editor } = createWithCompletion();
      editor.handleInput("/");
      editor.handleInput("h");
      editor.handleInput("e");
      editor.handleInput("l");
      editor.handleInput("p");
      editor.handleInput(" ");
      const lines = editor.render(80);
      // base 4 lines, no popup (space dismisses it)
      expect(lines).toHaveLength(4);
    });

    test("popup hidden for // prefix", () => {
      const { editor } = createWithCompletion();
      editor.handleInput("/");
      editor.handleInput("/");
      const lines = editor.render(80);
      expect(lines).toHaveLength(4);
    });

    test("up at top of list stays at top", () => {
      const { editor } = createWithCompletion();
      editor.handleInput("/");
      editor.handleInput("\x1b[A"); // up when already at index 0
      const lines = editor.render(80);
      expect(lines[4]).toContain("\u25b8");
      expect(lines[4]).toContain("help");
    });

    test("down at bottom of list stays at bottom", () => {
      const { editor } = createWithCompletion();
      editor.handleInput("/");
      editor.handleInput("\x1b[B"); // history
      editor.handleInput("\x1b[B"); // model
      editor.handleInput("\x1b[B"); // try to go past end
      const lines = editor.render(80);
      expect(lines[6]).toContain("\u25b8");
      expect(lines[6]).toContain("model");
    });

    test("popup renders correct number of lines", () => {
      const { editor } = createWithCompletion();
      editor.handleInput("/");
      const lines = editor.render(80);
      // blank + 3 popup items + top sep + input line + bottom sep = 7
      expect(lines).toHaveLength(7);
    });
  });
});
