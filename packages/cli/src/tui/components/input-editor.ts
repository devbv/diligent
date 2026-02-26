import { isPrintable, matchesKey } from "../framework/keys";
import type { Component, Focusable } from "../framework/types";
import { CURSOR_MARKER } from "../framework/types";

export interface InputEditorOptions {
  prompt?: string;
  onSubmit?: (text: string) => void;
  onCancel?: () => void;
  onExit?: () => void;
}

export class InputEditor implements Component, Focusable {
  focused = false;
  private text = "";
  private cursorPos = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private historyDraft = "";

  constructor(
    private options: InputEditorOptions,
    private requestRender: () => void,
  ) {}

  render(width: number): string[] {
    const prompt = this.options.prompt ?? "diligent> ";
    const maxTextWidth = width - prompt.length;

    if (!this.focused) {
      return [prompt + this.text];
    }

    // Build line with cursor marker embedded
    const before = this.text.slice(0, this.cursorPos);
    const after = this.text.slice(this.cursorPos);

    // Scroll if text is wider than terminal
    let displayBefore = before;
    let displayAfter = after;
    if (before.length + after.length > maxTextWidth && maxTextWidth > 0) {
      const scrollOffset = Math.max(0, before.length - Math.floor(maxTextWidth * 0.7));
      displayBefore = before.slice(scrollOffset);
      const remaining = maxTextWidth - displayBefore.length;
      displayAfter = after.slice(0, Math.max(0, remaining));
    }

    return [`\x1b[1;36m${prompt}\x1b[0m${displayBefore}${CURSOR_MARKER}${displayAfter}`];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "enter")) {
      const text = this.text.trim();
      if (text) {
        this.addToHistory(text);
        this.text = "";
        this.cursorPos = 0;
        this.historyIndex = -1;
        this.requestRender();
        this.options.onSubmit?.(text);
      }
      return;
    }

    if (matchesKey(data, "ctrl+c")) {
      this.options.onCancel?.();
      return;
    }

    if (matchesKey(data, "ctrl+d")) {
      if (this.text.length === 0) {
        this.options.onExit?.();
      }
      return;
    }

    // Ctrl+A — move to start
    if (matchesKey(data, "ctrl+a") || matchesKey(data, "home")) {
      this.cursorPos = 0;
      this.requestRender();
      return;
    }

    // Ctrl+E — move to end
    if (matchesKey(data, "ctrl+e") || matchesKey(data, "end")) {
      this.cursorPos = this.text.length;
      this.requestRender();
      return;
    }

    // Ctrl+K — delete to end of line
    if (matchesKey(data, "ctrl+k")) {
      this.text = this.text.slice(0, this.cursorPos);
      this.requestRender();
      return;
    }

    // Ctrl+U — delete to start of line
    if (matchesKey(data, "ctrl+u")) {
      this.text = this.text.slice(this.cursorPos);
      this.cursorPos = 0;
      this.requestRender();
      return;
    }

    // Ctrl+W — delete word backward
    if (matchesKey(data, "ctrl+w")) {
      const before = this.text.slice(0, this.cursorPos);
      const trimmed = before.replace(/\s+$/, "");
      const lastSpace = trimmed.lastIndexOf(" ");
      const newPos = lastSpace === -1 ? 0 : lastSpace + 1;
      this.text = this.text.slice(0, newPos) + this.text.slice(this.cursorPos);
      this.cursorPos = newPos;
      this.requestRender();
      return;
    }

    // Backspace
    if (matchesKey(data, "backspace")) {
      if (this.cursorPos > 0) {
        this.text = this.text.slice(0, this.cursorPos - 1) + this.text.slice(this.cursorPos);
        this.cursorPos--;
        this.requestRender();
      }
      return;
    }

    // Delete
    if (matchesKey(data, "delete")) {
      if (this.cursorPos < this.text.length) {
        this.text = this.text.slice(0, this.cursorPos) + this.text.slice(this.cursorPos + 1);
        this.requestRender();
      }
      return;
    }

    // Arrow left
    if (matchesKey(data, "left")) {
      if (this.cursorPos > 0) {
        this.cursorPos--;
        this.requestRender();
      }
      return;
    }

    // Arrow right
    if (matchesKey(data, "right")) {
      if (this.cursorPos < this.text.length) {
        this.cursorPos++;
        this.requestRender();
      }
      return;
    }

    // Arrow up — history
    if (matchesKey(data, "up")) {
      this.navigateHistory(1);
      return;
    }

    // Arrow down — history
    if (matchesKey(data, "down")) {
      this.navigateHistory(-1);
      return;
    }

    // Printable character
    if (isPrintable(data)) {
      this.text = this.text.slice(0, this.cursorPos) + data + this.text.slice(this.cursorPos);
      this.cursorPos += data.length;
      this.requestRender();
    }
  }

  invalidate(): void {
    // No cached state to clear
  }

  /** Clear input text */
  clear(): void {
    this.text = "";
    this.cursorPos = 0;
  }

  /** Set input text programmatically */
  setText(text: string): void {
    this.text = text;
    this.cursorPos = text.length;
  }

  /** Get current text */
  getText(): string {
    return this.text;
  }

  private addToHistory(text: string): void {
    // Don't add duplicates of the last entry
    if (this.history.length > 0 && this.history[this.history.length - 1] === text) {
      return;
    }
    this.history.push(text);
    // Keep history bounded
    if (this.history.length > 100) {
      this.history.shift();
    }
  }

  private navigateHistory(direction: number): void {
    if (this.history.length === 0) return;

    if (this.historyIndex === -1) {
      // Save current input as draft
      this.historyDraft = this.text;
    }

    const newIndex = this.historyIndex + direction;

    if (newIndex >= this.history.length) return;

    if (newIndex < 0) {
      // Return to draft
      this.historyIndex = -1;
      this.text = this.historyDraft;
      this.cursorPos = this.text.length;
      this.requestRender();
      return;
    }

    this.historyIndex = newIndex;
    // History is stored newest-last, navigate from end
    const histIdx = this.history.length - 1 - newIndex;
    this.text = this.history[histIdx];
    this.cursorPos = this.text.length;
    this.requestRender();
  }
}
