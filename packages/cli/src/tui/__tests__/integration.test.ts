/**
 * Integration tests: ChatView + InputEditor + StatusBar through a full
 * tool-execution cycle. Uses TerminalSim to track cursor and screen state.
 */
import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@diligent/core";
import { ChatView } from "../components/chat-view";
import { InputEditor } from "../components/input-editor";
import { StatusBar } from "../components/status-bar";
import { Container } from "../framework/container";
import { TUIRenderer } from "../framework/renderer";
import type { Terminal } from "../framework/terminal";

/** Minimal cast helper — test events don't need every field */
function ev(e: unknown): AgentEvent { return e as AgentEvent; }

// ---------------------------------------------------------------------------
// Terminal simulator (same as renderer.test.ts, minimal copy)
// ---------------------------------------------------------------------------

class TerminalSim {
  rows: number;
  columns: number;
  screen: string[] = [];
  cursorRow = 0;
  cursorCol = 0;

  constructor(rows = 40, columns = 120) {
    this.rows = rows;
    this.columns = columns;
  }

  feed(data: string): void {
    data = data.replace(/\x1b\[\?2026[hl]/g, "");
    let i = 0;
    while (i < data.length) {
      if (data[i] === "\x1b") {
        const seq = this._parseEscape(data, i);
        this._applyEscape(seq);
        i += seq.length;
      } else if (data[i] === "\r") {
        this.cursorCol = 0;
        i++;
      } else if (data[i] === "\n") {
        this.cursorRow++;
        while (this.screen.length <= this.cursorRow) this.screen.push("");
        i++;
      } else if (data.charCodeAt(i) >= 32) {
        this._writeChar(data[i]);
        i++;
      } else {
        i++; // skip other control chars
      }
    }
  }

  private _writeChar(ch: string): void {
    while (this.screen.length <= this.cursorRow) this.screen.push("");
    const row = this.screen[this.cursorRow];
    const before = row.slice(0, this.cursorCol);
    const after = row.slice(this.cursorCol + 1);
    this.screen[this.cursorRow] = before + ch + after;
    this.cursorCol++;
  }

  private _parseEscape(data: string, start: number): string {
    if (start + 1 >= data.length) return data[start];
    const next = data[start + 1];
    if (next === "[") {
      let i = start + 2;
      while (i < data.length && !data[i].match(/[A-Za-z]/)) i++;
      if (i < data.length) i++;
      return data.slice(start, i);
    }
    if (next === "_") {
      // APC: read until BEL
      let i = start + 2;
      while (i < data.length && data[i] !== "\x07") i++;
      if (i < data.length) i++;
      return data.slice(start, i);
    }
    return data.slice(start, start + 2);
  }

  private _applyEscape(seq: string): void {
    const csi = seq.match(/^\x1b\[(\??[0-9;]*)([A-Za-z])$/);
    if (!csi) return;
    const params = csi[1].replace("?", "");
    const cmd = csi[2];
    const n = parseInt(params !== "" ? params : "1", 10) || 1;
    switch (cmd) {
      case "A": this.cursorRow = Math.max(0, this.cursorRow - n); break;
      case "B":
        this.cursorRow += n;
        while (this.screen.length <= this.cursorRow) this.screen.push("");
        break;
      case "C": this.cursorCol += n; break;
      case "D": this.cursorCol = Math.max(0, this.cursorCol - n); break;
      case "H": // cursor position
        if (params === "" || params === "1;1") {
          this.cursorRow = 0;
          this.cursorCol = 0;
        } else if (params.includes(";")) {
          const parts = params.split(";");
          this.cursorRow = Math.max(0, (parseInt(parts[0] || "1", 10) || 1) - 1);
          this.cursorCol = Math.max(0, (parseInt(parts[1] || "1", 10) || 1) - 1);
        }
        break;
      case "J": {
        const jn = parseInt(params !== "" ? params : "0", 10);
        if (jn === 2) {
          this.screen = Array(this.rows).fill("");
          this.cursorRow = 0;
          this.cursorCol = 0;
        } else if (jn === 0) {
          // Erase from cursor to end of screen
          while (this.screen.length <= this.cursorRow) this.screen.push("");
          this.screen[this.cursorRow] = this.screen[this.cursorRow].slice(0, this.cursorCol);
          for (let i = this.cursorRow + 1; i < this.screen.length; i++) this.screen[i] = "";
        }
        break;
      }
      case "K":
        while (this.screen.length <= this.cursorRow) this.screen.push("");
        this.screen[this.cursorRow] = "";
        this.cursorCol = 0;
        break;
    }
  }

  /** Count how many rows contain the given text */
  countOccurrences(text: string): number {
    return this.screen.filter((l) => l.includes(text)).length;
  }

  lineAt(row: number): string {
    return this.screen[row] ?? "";
  }
}

function makeTerminal(sim: TerminalSim): Terminal {
  return {
    get columns() { return sim.columns; },
    get rows() { return sim.rows; },
    isKittyEnabled: false,
    write(data: string) { sim.feed(data); },
    writeSynchronized(data: string) { sim.feed(data); },
    hideCursor() {},
    showCursor() {},
    moveCursorTo(row: number, col: number) { sim.feed(`\x1b[${row + 1};${col + 1}H`); },
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    moveBy() {},
    start() {},
    stop() {},
  } as unknown as Terminal;
}

// ---------------------------------------------------------------------------
// Helpers to build the component stack
// ---------------------------------------------------------------------------

function buildStack() {
  const sim = new TerminalSim();
  const terminal = makeTerminal(sim);

  // We'll connect requestRender after renderer is created
  const requestRender = () => renderer.forceRender();

  const chatView = new ChatView({ requestRender });
  const inputEditor = new InputEditor(
    { onSubmit: () => {}, onCancel: () => {}, onExit: () => {} },
    requestRender,
  );
  const statusBar = new StatusBar();

  const container = new Container();
  container.addChild(chatView);
  container.addChild(inputEditor);
  container.addChild(statusBar);

  const renderer = new TUIRenderer(terminal, container);
  renderer.setFocus(inputEditor);
  renderer.start();

  return { sim, chatView, inputEditor, statusBar, renderer };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Filter lines for duplicate-content checks: exclude separators (lines of ─) and blank lines */
function contentLines(screen: string[]): string[] {
  return screen.filter((l) => l.trim().length > 0 && !/^─+$/.test(l.trim()));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: full tool execution cycle", () => {
  test("prompt appears exactly once after initial render", () => {
    const { sim } = buildStack();
    expect(sim.countOccurrences("› ")).toBe(1);
  });

  test("cursor is on the input row after initial render", () => {
    const { sim } = buildStack();
    // The input row text should be "› "
    expect(sim.lineAt(sim.cursorRow)).toBe("› ");
  });

  test("user message displayed, prompt appears exactly twice (history + live)", () => {
    const { sim, chatView } = buildStack();
    chatView.addUserMessage("hello world");
    // "› " appears in: history line + live input
    expect(sim.countOccurrences("› ")).toBe(2);
  });

  test("cursor stays on live input row after user message added", () => {
    const { sim, chatView } = buildStack();
    chatView.addUserMessage("hello world");
    expect(sim.lineAt(sim.cursorRow)).toBe("› ");
  });

  test("cursor stays on input row during tool execution (spinner active)", () => {
    const { sim, chatView } = buildStack();
    chatView.addUserMessage("run something");

    chatView.handleEvent(ev({ type: "tool_start", toolName: "bash", toolCallId: "t1", itemId: "i1", input: {} }));

    expect(sim.lineAt(sim.cursorRow)).toBe("› ");
  });

  test("cursor stays on input row after tool ends with output", () => {
    const { sim, chatView } = buildStack();
    chatView.addUserMessage("run something");

    chatView.handleEvent(ev({ type: "tool_start", toolName: "bash", toolCallId: "t1", itemId: "i1", input: {} }));
    chatView.handleEvent(ev({
      type: "tool_end",
      toolCallId: "t1",
      itemId: "i1",
      toolName: "bash",
      output: "line1\nline2\nline3",
      isError: false,
    }));

    expect(sim.lineAt(sim.cursorRow)).toBe("› ");
  });

  test("prompt count stays at 2 after full tool + response cycle", () => {
    const { sim, chatView } = buildStack();
    chatView.addUserMessage("do stuff");

    chatView.handleEvent(ev({ type: "tool_start", toolName: "bash", toolCallId: "t1", itemId: "i1", input: {} }));
    chatView.handleEvent(ev({ type: "tool_end", toolCallId: "t1", itemId: "i1", toolName: "bash", output: "done", isError: false }));
    chatView.handleEvent(ev({ type: "message_start", itemId: "m1", message: {} }));
    chatView.handleEvent(ev({
      type: "message_delta",
      itemId: "m1",
      message: {},
      delta: { type: "text_delta", delta: "The result is done.\n" },
    }));
    chatView.handleEvent(ev({ type: "message_end", itemId: "m1", message: {} }));
    chatView.handleEvent(ev({
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: 0.001,
    }));

    // Only 2 "› ": one in user message history, one live input
    expect(sim.countOccurrences("› ")).toBe(2);
    expect(sim.lineAt(sim.cursorRow)).toBe("› ");
  });

  test("cursor col is 0 after clearing input", () => {
    const { sim, inputEditor } = buildStack();
    inputEditor.handleInput("h");
    inputEditor.handleInput("i");
    inputEditor.clear();

    expect(sim.lineAt(sim.cursorRow)).toBe("› ");
    expect(sim.cursorCol).toBe(2); // "› " length = 2
  });

  test("cursor col advances as user types", () => {
    const { sim, inputEditor } = buildStack();
    inputEditor.handleInput("a");
    inputEditor.handleInput("b");
    inputEditor.handleInput("c");

    // "› abc" → cursor col = 5
    expect(sim.cursorCol).toBe(5);
  });

  test("multiple tool calls don't drift cursor off input row", () => {
    const { sim, chatView } = buildStack();
    chatView.addUserMessage("do lots of stuff");

    for (let i = 0; i < 5; i++) {
      chatView.handleEvent(ev({ type: "tool_start", toolName: `tool${i}`, toolCallId: `tc${i}`, itemId: `i${i}`, input: {} }));
      chatView.handleEvent(ev({
        type: "tool_end",
        toolCallId: `tc${i}`,
        itemId: `i${i}`,
        toolName: `tool${i}`,
        output: `output of tool${i}\nwith two lines`,
        isError: false,
      }));
    }

    expect(sim.lineAt(sim.cursorRow)).toBe("› ");
  });
});

describe("Integration: streaming markdown — rapid commits", () => {
  test("multi-paragraph streaming leaves no duplicate content on screen", () => {
    const { sim, chatView } = buildStack();
    chatView.addUserMessage("explain the project");

    // Simulate LLM streaming paragraph by paragraph (each ends with \n)
    chatView.handleEvent(ev({ type: "message_start", itemId: "m1", message: {} }));

    const deltas = [
      "Hello! Welcome to the project.\n",
      "\n",
      "The project uses Bun + TypeScript.\n",
      "\n",
      "Key features:\n",
      "- Feature one\n",
      "- Feature two\n",
      "- Feature three\n",
    ];

    for (const delta of deltas) {
      chatView.handleEvent(ev({ type: "message_delta", itemId: "m1", message: {}, delta: { type: "text_delta", delta } }));
    }
    chatView.handleEvent(ev({ type: "message_end", itemId: "m1", message: {} }));

    // "› " in history (user message) + live input = 2
    expect(sim.countOccurrences("› ")).toBe(2);
    expect(sim.lineAt(sim.cursorRow)).toBe("› ");
    // Streamed content is visible and not duplicated
    const nonEmpty = contentLines(sim.screen);
    expect(nonEmpty.length).toBe(new Set(nonEmpty).size);
    expect(sim.screen.some((l) => l.includes("Hello! Welcome"))).toBe(true);
    expect(sim.screen.some((l) => l.includes("Feature one"))).toBe(true);
  });

  test("partial commit mid-bold does not corrupt screen", () => {
    const { sim, chatView } = buildStack();
    chatView.addUserMessage("test");

    chatView.handleEvent(ev({ type: "message_start", itemId: "m1", message: {} }));
    // Partial bold: ** opens but no close yet
    chatView.handleEvent(ev({
      type: "message_delta", itemId: "m1", message: {},
      delta: { type: "text_delta", delta: "The project is in **Phase 4b" },
    }));
    // Newline commits while bold is still open
    chatView.handleEvent(ev({
      type: "message_delta", itemId: "m1", message: {},
      delta: { type: "text_delta", delta: "** planning.\n" },
    }));
    chatView.handleEvent(ev({ type: "message_end", itemId: "m1", message: {} }));

    expect(sim.countOccurrences("› ")).toBe(2);
    expect(sim.lineAt(sim.cursorRow)).toBe("› ");
    // The bold text should be visible on screen (no corruption → raw ** not present)
    const allText = sim.screen.join(" ");
    expect(allText).toContain("Phase 4b");
    expect(allText).toContain("planning");
    expect(allText).not.toContain("**");
  });

  test("no duplicate non-empty lines after each commit", () => {
    const { sim, chatView } = buildStack();
    chatView.addUserMessage("go");

    chatView.handleEvent(ev({ type: "message_start", itemId: "m1", message: {} }));

    const lines = ["First line.\n", "Second line.\n", "Third line.\n"];

    for (const delta of lines) {
      chatView.handleEvent(ev({
        type: "message_delta", itemId: "m1", message: {},
        delta: { type: "text_delta", delta },
      }));
      // Within a single render, no line should appear more than once
      const nonEmpty = contentLines(sim.screen);
      expect(nonEmpty.length).toBe(new Set(nonEmpty).size);
    }

    chatView.handleEvent(ev({ type: "message_end", itemId: "m1", message: {} }));
    // After all commits, each line is visible exactly once
    expect(sim.screen.some((l) => l.includes("First line."))).toBe(true);
    expect(sim.screen.some((l) => l.includes("Second line."))).toBe(true);
    expect(sim.screen.some((l) => l.includes("Third line."))).toBe(true);
    expect(sim.countOccurrences("First line.")).toBe(1);
    expect(sim.countOccurrences("Second line.")).toBe(1);
    expect(sim.countOccurrences("Third line.")).toBe(1);
  });

  test("markdown re-render with growing paragraph does not duplicate", () => {
    // Specific regression: "First line.\n" → 1 rendered line
    // "First line.\nSecond line.\n" → may be 1 or 2 lines depending on markdown
    // Either way, same content must not appear twice on screen
    const { sim, chatView } = buildStack();
    chatView.addUserMessage("go");
    chatView.handleEvent(ev({ type: "message_start", itemId: "m1", message: {} }));

    chatView.handleEvent(ev({
      type: "message_delta", itemId: "m1", message: {},
      delta: { type: "text_delta", delta: "First line.\n" },
    }));
    const afterFirst = contentLines(sim.screen);
    expect(afterFirst.length).toBe(new Set(afterFirst).size);

    chatView.handleEvent(ev({
      type: "message_delta", itemId: "m1", message: {},
      delta: { type: "text_delta", delta: "Second line.\n" },
    }));
    const afterSecond = contentLines(sim.screen);
    expect(afterSecond.length).toBe(new Set(afterSecond).size);

    chatView.handleEvent(ev({ type: "message_end", itemId: "m1", message: {} }));
    const afterEnd = contentLines(sim.screen);
    expect(afterEnd.length).toBe(new Set(afterEnd).size);
    // Both lines are present and each appears exactly once
    expect(sim.screen.some((l) => l.includes("First line."))).toBe(true);
    expect(sim.screen.some((l) => l.includes("Second line."))).toBe(true);
    expect(sim.countOccurrences("First line.")).toBe(1);
    expect(sim.countOccurrences("Second line.")).toBe(1);
  });
});

