import { describe, expect, test } from "bun:test";
import { Container } from "../container";
import { TUIRenderer } from "../renderer";
import type { Terminal } from "../terminal";
import type { Component } from "../types";

function createMockTerminal(): Terminal & { output: string[]; syncOutput: string[] } {
  const output: string[] = [];
  const syncOutput: string[] = [];

  return {
    output,
    syncOutput,
    columns: 80,
    rows: 24,
    isKittyEnabled: false,
    write(data: string) {
      output.push(data);
    },
    writeSynchronized(data: string) {
      syncOutput.push(data);
    },
    hideCursor() {
      output.push("HIDE_CURSOR");
    },
    showCursor() {
      output.push("SHOW_CURSOR");
    },
    moveCursorTo(_row: number, _col: number) {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    moveBy(_lines: number) {},
    start() {},
    stop() {},
  } as unknown as Terminal & { output: string[]; syncOutput: string[] };
}

function createStaticComponent(lines: string[]): Component {
  return {
    render(_width: number) {
      return [...lines];
    },
    invalidate() {},
  };
}

describe("TUIRenderer", () => {
  test("renders initial content", () => {
    const terminal = createMockTerminal();
    const component = createStaticComponent(["Hello", "World"]);
    const renderer = new TUIRenderer(terminal, component);

    renderer.start();

    // Should have rendered via synchronized output
    expect(terminal.syncOutput.length).toBeGreaterThan(0);
    const rendered = terminal.syncOutput.join("");
    expect(rendered).toContain("Hello");
    expect(rendered).toContain("World");
  });

  test("only emits changed lines on update", () => {
    const terminal = createMockTerminal();
    let lines = ["Line 1", "Line 2", "Line 3"];
    const component: Component = {
      render(_width: number) {
        return [...lines];
      },
      invalidate() {},
    };

    const renderer = new TUIRenderer(terminal, component);
    renderer.start();

    // Clear output from first render
    terminal.syncOutput.length = 0;

    // Change only one line
    lines = ["Line 1", "Changed", "Line 3"];
    renderer.forceRender();

    expect(terminal.syncOutput.length).toBeGreaterThan(0);
    const update = terminal.syncOutput.join("");
    expect(update).toContain("Changed");
  });

  test("handles content growth", () => {
    const terminal = createMockTerminal();
    let lines = ["Line 1"];
    const component: Component = {
      render(_width: number) {
        return [...lines];
      },
      invalidate() {},
    };

    const renderer = new TUIRenderer(terminal, component);
    renderer.start();
    terminal.syncOutput.length = 0;

    // Add more lines
    lines = ["Line 1", "Line 2", "Line 3"];
    renderer.forceRender();

    const update = terminal.syncOutput.join("");
    expect(update).toContain("Line 2");
    expect(update).toContain("Line 3");
  });

  test("handles content shrink", () => {
    const terminal = createMockTerminal();
    let lines = ["Line 1", "Line 2", "Line 3"];
    const component: Component = {
      render(_width: number) {
        return [...lines];
      },
      invalidate() {},
    };

    const renderer = new TUIRenderer(terminal, component);
    renderer.start();
    terminal.syncOutput.length = 0;

    // Remove lines
    lines = ["Line 1"];
    renderer.forceRender();

    // Should have emitted clear sequences for removed lines
    expect(terminal.syncOutput.length).toBeGreaterThan(0);
  });

  test("no output when nothing changes", () => {
    const terminal = createMockTerminal();
    const lines = ["Static line"];
    const component = createStaticComponent(lines);

    const renderer = new TUIRenderer(terminal, component);
    renderer.start();
    terminal.syncOutput.length = 0;

    renderer.forceRender();

    // Should still emit synchronized output, but with minimal changes
    // (move up and back down)
    const update = terminal.syncOutput.join("");
    expect(update).not.toContain("Static line");
  });
});

describe("Container", () => {
  test("renders children vertically", () => {
    const container = new Container();
    container.addChild(createStaticComponent(["A"]));
    container.addChild(createStaticComponent(["B"]));
    container.addChild(createStaticComponent(["C"]));

    expect(container.render(80)).toEqual(["A", "B", "C"]);
  });

  test("removes child", () => {
    const container = new Container();
    const child = createStaticComponent(["B"]);
    container.addChild(createStaticComponent(["A"]));
    container.addChild(child);
    container.addChild(createStaticComponent(["C"]));

    container.removeChild(child);
    expect(container.render(80)).toEqual(["A", "C"]);
  });

  test("inserts before child", () => {
    const container = new Container();
    const childB = createStaticComponent(["B"]);
    container.addChild(createStaticComponent(["A"]));
    container.addChild(childB);

    container.insertBefore(createStaticComponent(["X"]), childB);
    expect(container.render(80)).toEqual(["A", "X", "B"]);
  });

  test("handles empty children", () => {
    const container = new Container();
    expect(container.render(80)).toEqual([]);
  });

  test("delegates handleInput to first child with handler", () => {
    const container = new Container();
    const received: string[] = [];

    container.addChild(createStaticComponent(["no handler"]));
    container.addChild({
      render: () => ["with handler"],
      handleInput: (data: string) => received.push(data),
      invalidate: () => {},
    });

    container.handleInput("x");
    expect(received).toEqual(["x"]);
  });
});
