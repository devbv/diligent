// @summary Tests for TUI structured tool payload block rendering
import { describe, expect, test } from "bun:test";
import type { ToolRenderPayload } from "@diligent/protocol";
import { TUIRenderer } from "../../src/tui/framework/renderer";
import type { Terminal } from "../../src/tui/framework/terminal";
import type { Component } from "../../src/tui/framework/types";
import { renderToolPayload } from "../../src/tui/render-blocks";

describe("renderToolPayload", () => {
  test("renders file block header and content", () => {
    const payload: ToolRenderPayload = {
      blocks: [
        {
          type: "file",
          filePath: "packages/cli/src/tui/chat-view.ts",
          content: "line1\nline2",
          offset: 10,
          limit: 2,
        },
      ],
    };

    const lines = renderToolPayload(payload);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes("packages/cli/src/tui/chat-view.ts"))).toBe(true);
    expect(lines.some((line) => line.includes("L10-11"))).toBe(true);
    expect(lines.some((line) => line.includes("line1"))).toBe(true);
    expect(lines.some((line) => line.includes("line2"))).toBe(true);
  });

  test("renders command block with command and output", () => {
    const payload: ToolRenderPayload = {
      blocks: [
        {
          type: "command",
          command: "echo hello",
          output: "hello",
          isError: false,
        },
      ],
    };

    const lines = renderToolPayload(payload);
    expect(lines[0]?.includes("echo hello")).toBe(true);
    expect(lines.some((line) => line.includes("hello"))).toBe(true);
  });

  test("renders diff block action/path and hunk lines", () => {
    const payload: ToolRenderPayload = {
      blocks: [
        {
          type: "diff",
          files: [
            {
              filePath: "src/a.ts",
              action: "Update",
              hunks: [{ oldString: "const a = 1;", newString: "const a = 2;" }],
            },
          ],
          output: "Updated src/a.ts",
        },
      ],
    };

    const lines = renderToolPayload(payload);
    expect(lines.some((line) => line.includes("src/a.ts"))).toBe(true);
    expect(lines.some((line) => line.includes("[Update]"))).toBe(true);
    expect(lines.some((line) => line.includes("- const a = 1;"))).toBe(true);
    expect(lines.some((line) => line.includes("+ const a = 2;"))).toBe(true);
    expect(lines.some((line) => line.includes("Updated src/a.ts"))).toBe(true);
  });

  test("renders mixed blocks without dropping known block types", () => {
    const payload: ToolRenderPayload = {
      blocks: [
        { type: "summary", text: "done", tone: "success" },
        { type: "file", filePath: "x.ts", content: "x" },
        { type: "command", command: "pwd", output: "/tmp" },
      ],
    };

    const lines = renderToolPayload(payload);
    expect(lines.some((line) => line.includes("done"))).toBe(true);
    expect(lines.some((line) => line.includes("x.ts"))).toBe(true);
    expect(lines.some((line) => line.includes("pwd"))).toBe(true);
    expect(lines.some((line) => line.includes("/tmp"))).toBe(true);
  });

  test("renders asset gallery blocks as selectable text rows", () => {
    const payload: ToolRenderPayload = {
      blocks: [
        {
          type: "asset_gallery",
          title: "Assets",
          query: "fountain classic stone",
          actionLabel: "Click a result to insert it",
          items: [
            {
              id: "asset-fountain-1",
              title: "Classic Stone Fountain",
              subtitle: "MODEL",
              price: "Free",
              thumbnailUrl: "https://assets.example/fountain.png",
            },
          ],
        },
      ],
    };

    const lines = renderToolPayload(payload);
    expect(lines.some((line) => line.includes("Assets"))).toBe(true);
    expect(lines.some((line) => line.includes('1 result for "fountain classic stone"'))).toBe(true);
    expect(lines.some((line) => line.includes("Classic Stone Fountain"))).toBe(true);
    expect(lines.some((line) => line.includes("[Free]"))).toBe(true);
    expect(lines.some((line) => line.includes("Click a result to insert it"))).toBe(true);
  });

  test("keeps rendering when payload includes unknown block shape", () => {
    const payload = {
      blocks: [
        { type: "summary", text: "ok" },
        { type: "future_block", title: "future" },
      ],
    } as unknown as ToolRenderPayload;

    const lines = renderToolPayload(payload);
    expect(lines.some((line) => line.includes("ok"))).toBe(true);
    expect(lines.some((line) => line.includes("unsupported block"))).toBe(true);
    expect(lines.some((line) => line.includes("future_block"))).toBe(true);
  });

  test("keeps rendering when a malformed known block throws", () => {
    const payload = {
      blocks: [{ type: "summary", text: "ok" }, { type: "table" }],
    } as unknown as ToolRenderPayload;

    const lines = renderToolPayload(payload);
    expect(lines.some((line) => line.includes("ok"))).toBe(true);
    expect(lines.some((line) => line.includes("render error"))).toBe(true);
    expect(lines.some((line) => line.includes("table"))).toBe(true);
  });

  test("renders text blocks for generic fallback payloads", () => {
    const payload: ToolRenderPayload = {
      blocks: [
        { type: "text", title: "Input", text: '{"alpha":1}' },
        { type: "text", title: "Output", text: "failed", isError: true },
      ],
    };

    const lines = renderToolPayload(payload);
    expect(lines.some((line) => line.includes("Input"))).toBe(true);
    expect(lines.some((line) => line.includes('{"alpha":1}'))).toBe(true);
    expect(lines.some((line) => line.includes("failed"))).toBe(true);
  });
});

describe("TUIRenderer resilience", () => {
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
      moveCursorTo() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
      moveBy() {},
      start() {},
      stop() {},
    } as unknown as Terminal & { output: string[]; syncOutput: string[] };
  }

  test("survives render exceptions and keeps frame alive", () => {
    const terminal = createMockTerminal();
    let throwOnce = true;
    const component: Component = {
      render() {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("boom");
        }
        return ["ok"];
      },
      invalidate() {},
    };

    const renderer = new TUIRenderer(terminal, component);
    renderer.start();

    const firstFrame = terminal.syncOutput.join("");
    expect(firstFrame).toContain("[render error] boom");

    terminal.syncOutput.length = 0;
    renderer.forceRender();
    const secondFrame = terminal.syncOutput.join("");
    expect(secondFrame).toContain("ok");
  });
});
