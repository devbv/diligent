import { debugLogger } from "./debug-logger";
import type { OverlayStack } from "./overlay";
import { charDisplayWidth, displayWidth } from "./string-width";
import type { Terminal } from "./terminal";
import type { Component, Focusable } from "./types";
import { CURSOR_MARKER } from "./types";

/** Strip ANSI escape codes for measuring visible width */
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[a-zA-Z]`, "g");
const ANSI_PRIVATE_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[\\?[0-9;]*[a-zA-Z]`, "g");
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "").replace(ANSI_PRIVATE_RE, "");
}

/**
 * TUI renderer using inline viewport — content is written to the normal terminal
 * buffer, and each render rewinds to the start of the previous frame before
 * overwriting.  No alternate screen is used, so the terminal's native scrollback
 * and text-selection features remain available.
 */
export class TUIRenderer {
  private renderScheduled = false;
  private focusedComponent: (Component & Focusable) | null = null;
  private overlayStack: OverlayStack | null = null;
  private started = false;
  private flushedCommittedCount = 0; // committed lines already written to scrollback
  private lastActiveRows = 0; // terminal rows occupied by previous active region
  private lastCursorRowInActive = 0; // cursor row within active region (for rewind)

  constructor(
    private terminal: Terminal,
    private root: Component,
  ) {}

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
    this.terminal.hideCursor();
    this.doRender();
  }

  /** Stop rendering — clear active region, leave committed lines in scrollback */
  stop(): void {
    this.started = false;
    this.renderScheduled = false;
    // Erase active region so only committed lines remain in scrollback
    if (this.lastActiveRows > 0) {
      this.terminal.write("\r");
      if (this.lastCursorRowInActive > 0) {
        this.terminal.write(`\x1b[${this.lastCursorRowInActive}A`);
      }
      this.terminal.write("\x1b[0J");
    }
    this.lastActiveRows = 0;
    this.lastCursorRowInActive = 0;
    this.flushedCommittedCount = 0;
    this.terminal.showCursor();
  }

  /** Count how many terminal rows a set of lines occupies given terminal width */
  private countTerminalRows(lines: string[], width: number): number {
    return lines.reduce((sum, line) => {
      const visible = displayWidth(stripAnsi(line));
      return sum + Math.max(1, Math.ceil(visible / width));
    }, 0);
  }

  /** Render with committed/active split: committed lines go to scrollback once,
   *  active lines are redrawn each frame. */
  private doRender(): void {
    const width = this.terminal.columns;
    const allLines = this.root.render(width);

    // Determine committed line count (monotonically increasing)
    let committedCount = this.root.getCommittedLineCount?.(width) ?? 0;
    committedCount = Math.max(committedCount, this.flushedCommittedCount);

    // Split into committed and active regions
    const committedLines = allLines.slice(0, committedCount);
    let activeLines = allLines.slice(committedCount);

    // Apply overlays only to the active region
    if (this.overlayStack?.hasVisible()) {
      activeLines = this.compositeOverlays(activeLines, width);
    }

    // Find cursor marker — only in active region
    let cursorRow = -1;
    let cursorCol = -1;
    const cleanActive: string[] = [];
    for (let i = 0; i < activeLines.length; i++) {
      const markerIdx = activeLines[i].indexOf(CURSOR_MARKER);
      if (markerIdx !== -1) {
        cursorRow = i;
        cursorCol = displayWidth(stripAnsi(activeLines[i].slice(0, markerIdx)));
        cleanActive.push(activeLines[i].replace(CURSOR_MARKER, ""));
      } else {
        cleanActive.push(activeLines[i]);
      }
    }

    // Cap active lines to terminal height
    const maxLines = this.terminal.rows;
    let displayActiveLines = cleanActive;
    let displayCursorRow = cursorRow;
    if (cleanActive.length > maxLines) {
      const startIdx = cleanActive.length - maxLines;
      displayActiveLines = cleanActive.slice(startIdx);
      if (cursorRow !== -1) {
        displayCursorRow = cursorRow - startIdx;
        if (displayCursorRow < 0 || displayCursorRow >= maxLines) {
          displayCursorRow = -1;
          cursorCol = -1;
        }
      }
    }

    // How many new committed lines to flush this frame
    const newCommittedCount = committedCount - this.flushedCommittedCount;

    // Erase previous active region
    if (this.lastActiveRows > 0) {
      this.terminal.write("\r");
      if (this.lastCursorRowInActive > 0) {
        this.terminal.write(`\x1b[${this.lastCursorRowInActive}A`);
      }
      this.terminal.write("\x1b[0J");
    }

    // Write newly committed lines to scrollback (permanent)
    if (newCommittedCount > 0) {
      const newLines = committedLines.slice(this.flushedCommittedCount);
      this.terminal.write(newLines.join("\r\n") + "\r\n");
      this.flushedCommittedCount = committedCount;
    }

    // Write active region (redrawn each frame)
    this.terminal.writeSynchronized(displayActiveLines.join("\r\n"));

    const totalActiveRows = this.countTerminalRows(displayActiveLines, width);
    this.lastActiveRows = totalActiveRows;

    // Position cursor within active region
    if (displayCursorRow !== -1 && cursorCol !== -1) {
      const rowsBefore = this.countTerminalRows(displayActiveLines.slice(0, displayCursorRow), width);
      const rowsToMoveUp = totalActiveRows - 1 - rowsBefore;
      this.terminal.write("\r");
      if (rowsToMoveUp > 0) {
        this.terminal.write(`\x1b[${rowsToMoveUp}A`);
      }
      if (cursorCol > 0) {
        this.terminal.write(`\x1b[${cursorCol}C`);
      }
      this.terminal.showCursor();
      this.lastCursorRowInActive = rowsBefore;
    } else {
      this.terminal.hideCursor();
      this.lastCursorRowInActive = totalActiveRows - 1;
    }

    if (debugLogger.isEnabled) {
      debugLogger.logRender({
        termCols: this.terminal.columns,
        termRows: this.terminal.rows,
        newLines: allLines,
        cleanLines: displayActiveLines,
        cursorRow: displayCursorRow,
        cursorCol,
        fullOutput: displayActiveLines.join("\n"),
      });
    }
  }

  private compositeOverlays(baseLines: string[], width: number): string[] {
    if (!this.overlayStack) return baseLines;

    const result = [...baseLines];
    const visible = this.overlayStack.getVisible();

    for (const { component, options } of visible) {
      const overlayLines = component.render(width);
      if (overlayLines.length === 0) continue;

      const overlayWidth = overlayLines.reduce(
        (max: number, line: string) => Math.max(max, displayWidth(stripAnsi(line))),
        0,
      );

      // Resolve position — use content height (not terminal.rows) for inline viewport
      let startRow: number;
      let startCol: number;
      const anchor = options.anchor ?? "center";
      const totalRows = baseLines.length;

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
          const baseVisibleWidth = displayWidth(stripAnsi(baseLine));

          // Build composited line: base before overlay, overlay, base after overlay
          let composited = "";

          // Pad base to reach startCol
          if (baseVisibleWidth < startCol) {
            composited = baseLine + " ".repeat(startCol - baseVisibleWidth);
          } else {
            // Reconstruct base up to startCol (preserving ANSI)
            composited = this.sliceWithAnsi(baseLine, 0, startCol);
          }

          composited += "\x1b[0m" + overlayLines[i] + "\x1b[0m";

          // Add rest of base line after overlay
          const overlayVisibleWidth = displayWidth(stripAnsi(overlayLines[i]));
          const afterCol = startCol + overlayVisibleWidth;
          if (baseVisibleWidth > afterCol) {
            composited += this.sliceWithAnsi(baseLine, afterCol, baseVisibleWidth);
          }

          result[row] = composited;
        }
      }
    }

    return result;
  }

  /** Slice a string with ANSI codes by visible column positions */
  private sliceWithAnsi(str: string, start: number, end: number): string {
    let colIdx = 0;
    let result = "";
    let inEscape = false;
    let escapeSeq = "";

    for (const ch of str) {
      if (ch === "\x1b" || inEscape) {
        if (ch === "\x1b") {
          inEscape = true;
          escapeSeq = "\x1b";
        } else {
          escapeSeq += ch;
          if (ch.match(/[a-zA-Z]/)) {
            inEscape = false;
            if (colIdx >= start && colIdx < end) {
              result += escapeSeq;
            }
            escapeSeq = "";
          }
        }
        continue;
      }

      const w = charDisplayWidth(ch.codePointAt(0)!);
      if (colIdx >= start && colIdx + w <= end) {
        result += ch;
      }
      colIdx += w;

      if (colIdx >= end) break;
    }

    return result;
  }
}
