import type { OverlayStack } from "./overlay";
import type { Terminal } from "./terminal";
import type { Component, Focusable } from "./types";

/** Strip ANSI escape codes for measuring visible width */
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[a-zA-Z]`, "g");
const ANSI_PRIVATE_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[\\?[0-9;]*[a-zA-Z]`, "g");
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "").replace(ANSI_PRIVATE_RE, "");
}

/**
 * TUI renderer with line-level differential rendering and overlay compositing.
 * Renders inline (no alternate screen) — content grows downward naturally.
 */
export class TUIRenderer {
  private previousLines: string[] = [];
  private renderScheduled = false;
  private focusedComponent: (Component & Focusable) | null = null;
  private overlayStack: OverlayStack | null = null;
  private started = false;
  private cursorMarker: string;

  constructor(
    private terminal: Terminal,
    private root: Component,
  ) {
    // Import CURSOR_MARKER value
    this.cursorMarker = "\x1b[?25h\x1b[?8c";
  }

  /** Set the overlay stack for compositing */
  setOverlayStack(overlayStack: OverlayStack): void {
    this.overlayStack = overlayStack;
  }

  /** Schedule a render on next tick (coalesces multiple requests) */
  requestRender(): void {
    if (this.renderScheduled || !this.started) return;
    this.renderScheduled = true;
    queueMicrotask(() => {
      this.renderScheduled = false;
      if (this.started) {
        this.doRender();
      }
    });
  }

  /** Force an immediate render */
  forceRender(): void {
    if (this.started) {
      this.doRender();
    }
  }

  /** Set which component receives hardware cursor focus */
  setFocus(component: (Component & Focusable) | null): void {
    if (this.focusedComponent) {
      this.focusedComponent.focused = false;
    }
    this.focusedComponent = component;
    if (component) {
      component.focused = true;
    }
  }

  /** Start the render loop */
  start(): void {
    this.started = true;
    this.previousLines = [];
    this.doRender();
  }

  /** Stop rendering, clear state */
  stop(): void {
    this.started = false;
    this.previousLines = [];
    this.renderScheduled = false;
  }

  /** Perform a render: render root, diff, emit changes */
  private doRender(): void {
    const width = this.terminal.columns;
    let newLines = this.root.render(width);

    // Composite overlays
    if (this.overlayStack?.hasVisible()) {
      newLines = this.compositeOverlays(newLines, width);
    }

    // Find cursor marker position
    let cursorRow = -1;
    let cursorCol = -1;
    const cleanLines: string[] = [];

    for (let i = 0; i < newLines.length; i++) {
      const markerIdx = newLines[i].indexOf(this.cursorMarker);
      if (markerIdx !== -1) {
        cursorRow = i;
        // Calculate visible column position (before marker)
        const beforeMarker = newLines[i].slice(0, markerIdx);
        cursorCol = stripAnsi(beforeMarker).length;
        cleanLines.push(newLines[i].replace(this.cursorMarker, ""));
      } else {
        cleanLines.push(newLines[i]);
      }
    }

    // Diff and emit changes
    const output = this.buildDiffOutput(cleanLines);
    if (output) {
      this.terminal.writeSynchronized(output);
    }

    // Position hardware cursor
    if (cursorRow !== -1 && cursorCol !== -1) {
      // Calculate absolute position: we're at the end of the rendered content
      const linesFromBottom = cleanLines.length - 1 - cursorRow;
      if (linesFromBottom > 0) {
        this.terminal.write(`\x1b[${linesFromBottom}A`);
      }
      this.terminal.write(`\r\x1b[${cursorCol}C`);
      this.terminal.showCursor();
    } else {
      this.terminal.hideCursor();
    }

    this.previousLines = cleanLines;
  }

  private buildDiffOutput(newLines: string[]): string {
    const prev = this.previousLines;
    let output = "";

    if (prev.length === 0) {
      // First render — emit all lines
      output = newLines.join("\n");
      if (newLines.length > 0) output += "\n";
      return output;
    }

    // Move cursor to beginning of previous content
    if (prev.length > 0) {
      output += `\x1b[${prev.length}A\r`;
    }

    // Find first and last changed line
    const maxLen = Math.max(prev.length, newLines.length);
    let firstChanged = -1;
    let lastChanged = -1;

    for (let i = 0; i < maxLen; i++) {
      const oldLine = i < prev.length ? prev[i] : undefined;
      const newLine = i < newLines.length ? newLines[i] : undefined;
      if (oldLine !== newLine) {
        if (firstChanged === -1) firstChanged = i;
        lastChanged = i;
      }
    }

    if (firstChanged === -1) {
      // No changes — move cursor back down
      if (prev.length > 0) {
        output += `\x1b[${prev.length}B`;
      }
      return output;
    }

    // Skip to first changed line
    if (firstChanged > 0) {
      output += `\x1b[${firstChanged}B`;
    }

    // Rewrite changed region
    for (let i = firstChanged; i <= lastChanged; i++) {
      output += "\x1b[2K"; // Clear line
      if (i < newLines.length) {
        output += newLines[i];
      }
      if (i < lastChanged) {
        output += "\n";
      }
    }

    // Clear excess old lines if content shrunk
    if (newLines.length < prev.length) {
      for (let i = newLines.length; i < prev.length; i++) {
        output += "\n\x1b[2K";
      }
      // Move back up to end of new content
      const excess = prev.length - newLines.length;
      if (excess > 0) {
        output += `\x1b[${excess}A`;
      }
    }

    // Move to end of new content
    const remaining = newLines.length - 1 - lastChanged;
    if (remaining > 0) {
      output += `\x1b[${remaining}B`;
    }
    output += "\r\n";

    return output;
  }

  private compositeOverlays(baseLines: string[], width: number): string[] {
    if (!this.overlayStack) return baseLines;

    const result = [...baseLines];
    const visible = this.overlayStack.getVisible();

    for (const { component, options } of visible) {
      const overlayLines = component.render(width);
      if (overlayLines.length === 0) continue;

      const overlayWidth = overlayLines.reduce((max: number, line: string) => Math.max(max, stripAnsi(line).length), 0);

      // Resolve position
      let startRow: number;
      let startCol: number;
      const anchor = options.anchor ?? "center";

      const totalRows = Math.max(result.length, this.terminal.rows);

      switch (anchor) {
        case "center":
          startRow = Math.max(0, Math.floor((totalRows - overlayLines.length) / 2));
          startCol = Math.max(0, Math.floor((width - overlayWidth) / 2));
          break;
        case "bottom-center":
          startRow = Math.max(0, totalRows - overlayLines.length - 2);
          startCol = Math.max(0, Math.floor((width - overlayWidth) / 2));
          break;
        case "top-left":
          startRow = options.offsetY ?? 0;
          startCol = options.offsetX ?? 0;
          break;
        default:
          startRow = Math.max(0, Math.floor((totalRows - overlayLines.length) / 2));
          startCol = Math.max(0, Math.floor((width - overlayWidth) / 2));
      }

      // Ensure enough lines exist
      while (result.length < startRow + overlayLines.length) {
        result.push("");
      }

      // Splice overlay lines into base
      for (let i = 0; i < overlayLines.length; i++) {
        const row = startRow + i;
        if (row < result.length) {
          const baseLine = result[row];
          const baseVisible = stripAnsi(baseLine);

          // Build composited line: base before overlay, overlay, base after overlay
          let composited = "";

          // Pad base to reach startCol
          if (baseVisible.length < startCol) {
            composited = baseLine + " ".repeat(startCol - baseVisible.length);
          } else {
            // Reconstruct base up to startCol (preserving ANSI)
            composited = this.sliceWithAnsi(baseLine, 0, startCol);
          }

          composited += "\x1b[0m" + overlayLines[i] + "\x1b[0m";

          // Add rest of base line after overlay
          const overlayVisibleWidth = stripAnsi(overlayLines[i]).length;
          const afterCol = startCol + overlayVisibleWidth;
          if (baseVisible.length > afterCol) {
            composited += this.sliceWithAnsi(baseLine, afterCol, baseVisible.length);
          }

          result[row] = composited;
        }
      }
    }

    return result;
  }

  /** Slice a string with ANSI codes by visible column positions */
  private sliceWithAnsi(str: string, start: number, end: number): string {
    let visibleIdx = 0;
    let result = "";
    let inEscape = false;
    let escapeSeq = "";

    for (let i = 0; i < str.length; i++) {
      if (str[i] === "\x1b") {
        inEscape = true;
        escapeSeq = "\x1b";
        continue;
      }

      if (inEscape) {
        escapeSeq += str[i];
        if (str[i].match(/[a-zA-Z]/)) {
          inEscape = false;
          // Include ANSI sequences that appear in range
          if (visibleIdx >= start && visibleIdx < end) {
            result += escapeSeq;
          }
          escapeSeq = "";
        }
        continue;
      }

      if (visibleIdx >= start && visibleIdx < end) {
        result += str[i];
      }
      visibleIdx++;

      if (visibleIdx >= end) break;
    }

    return result;
  }
}
