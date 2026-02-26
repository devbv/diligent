import type { Component } from "../framework/types";
import { renderMarkdown } from "../markdown";

/**
 * Streaming markdown renderer as a Component.
 * Implements newline-gated commit strategy (D047):
 * buffer incoming tokens, render only complete lines,
 * finalize remaining at stream end.
 */
export class MarkdownView implements Component {
  private buffer = "";
  private committedRaw = "";
  private committedLines: string[] = [];
  private finalized = false;
  private trailingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private requestRender: () => void) {}

  /** Push a text delta (streaming token) */
  pushDelta(delta: string): void {
    this.buffer += delta;

    // Clear trailing timer since we got new data
    if (this.trailingTimer) {
      clearTimeout(this.trailingTimer);
      this.trailingTimer = null;
    }

    // Newline-gated: commit only complete lines
    const lastNewline = this.buffer.lastIndexOf("\n");
    if (lastNewline !== -1) {
      const complete = this.buffer.slice(0, lastNewline + 1);
      this.buffer = this.buffer.slice(lastNewline + 1);
      this.committedRaw += complete;
      this.committedLines = this.renderToLines(this.committedRaw);
      this.requestRender();
    }

    // Start a short timer to force-render trailing content
    if (this.buffer.length > 0) {
      this.trailingTimer = setTimeout(() => {
        this.trailingTimer = null;
        if (this.buffer.length > 0 && !this.finalized) {
          this.requestRender();
        }
      }, 100);
    }
  }

  /** Finalize — render all remaining buffered content */
  finalize(): void {
    if (this.trailingTimer) {
      clearTimeout(this.trailingTimer);
      this.trailingTimer = null;
    }

    this.committedRaw += this.buffer;
    this.buffer = "";

    if (this.committedRaw.length > 0) {
      this.committedLines = this.renderToLines(this.committedRaw);
    }

    this.finalized = true;
    this.requestRender();
  }

  /** Reset for a new message */
  reset(): void {
    if (this.trailingTimer) {
      clearTimeout(this.trailingTimer);
      this.trailingTimer = null;
    }
    this.buffer = "";
    this.committedRaw = "";
    this.committedLines = [];
    this.finalized = false;
  }

  render(_width: number): string[] {
    if (this.committedLines.length === 0 && this.buffer.length === 0) {
      return [];
    }

    // If we have a trailing buffer (not yet committed via newline),
    // show committed lines + un-styled trailing text
    if (this.buffer.length > 0 && !this.finalized) {
      const trailingLines = this.buffer.split("\n");
      return [...this.committedLines, ...trailingLines];
    }

    return this.committedLines;
  }

  invalidate(): void {
    // Force re-render of committed content on next render
  }

  private renderToLines(text: string): string[] {
    const rendered = renderMarkdown(text, 80);
    if (!rendered) return [];
    return rendered.split("\n");
  }
}
