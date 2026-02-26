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
    const sep = `\x1b[2m${"─".repeat(Math.max(0, width))}\x1b[0m`;
    const prompt = this.options.prompt ?? "› ";
    const maxTextWidth = width - prompt.length;

    if (!this.focused) {
      return ["", sep, `\x1b[1;2m${prompt}\x1b[0m${this.text}`, sep];
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

    return ["", sep, `\x1b[1;2m${prompt}\x1b[0m${displayBefore}${CURSOR_MARKER}${displayAfter}`, sep];
  }

  /** Returns true if the key was consumed by the editor, false if the caller should handle it. */
  handleInput(data: string): boolean {
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
      return true;
    }

    if (matchesKey(data, "ctrl+c")) {
      this.options.onCancel?.();
      return true;
    }

    if (matchesKey(data, "ctrl+d")) {
      if (this.text.length === 0) {
        this.options.onExit?.();
      }
      return true;
    }

    // Ctrl+A — move to start
    if (matchesKey(data, "ctrl+a") || matchesKey(data, "home")) {
      this.cursorPos = 0;
      this.requestRender();
      return true;
    }

    // Ctrl+E — move to end
    if (matchesKey(data, "ctrl+e") || matchesKey(data, "end")) {
      this.cursorPos = this.text.length;
      this.requestRender();
      return true;
    }

    // Ctrl+K — delete to end of line
    if (matchesKey(data, "ctrl+k")) {
      this.text = this.text.slice(0, this.cursorPos);
      this.requestRender();
      return true;
    }

    // Ctrl+U — delete to start of line
    if (matchesKey(data, "ctrl+u")) {
      this.text = this.text.slice(this.cursorPos);
      this.cursorPos = 0;
      this.requestRender();
      return true;
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
      return true;
    }

    // Backspace
    if (matchesKey(data, "backspace")) {
      if (this.cursorPos > 0) {
        this.text = this.text.slice(0, this.cursorPos - 1) + this.text.slice(this.cursorPos);
        this.cursorPos--;
        this.requestRender();
      }
      return true;
    }

    // Delete
    if (matchesKey(data, "delete")) {
      if (this.cursorPos < this.text.length) {
        this.text = this.text.slice(0, this.cursorPos) + this.text.slice(this.cursorPos + 1);
        this.requestRender();
      }
      return true;
    }

    // Arrow left
    if (matchesKey(data, "left")) {
      if (this.cursorPos > 0) {
        this.cursorPos--;
        this.requestRender();
      }
      return true;
    }

    // Arrow right
    if (matchesKey(data, "right")) {
      if (this.cursorPos < this.text.length) {
        this.cursorPos++;
        this.requestRender();
      }
      return true;
    }

    // Arrow up/down — history navigation, guarded.
    // Returns false when the guard fails so the caller can handle it (e.g. scroll the view).
    if (matchesKey(data, "up")) {
      if (!this.shouldHandleNavigation()) return false;
      this.navigateHistory(1);
      return true;
    }

    if (matchesKey(data, "down")) {
      if (!this.shouldHandleNavigation()) return false;
      this.navigateHistory(-1);
      return true;
    }

    // Printable character
    if (isPrintable(data)) {
      this.text = this.text.slice(0, this.cursorPos) + data + this.text.slice(this.cursorPos);
      this.cursorPos += data.length;
      this.requestRender();
      return true;
    }

    return false;
  }

  /**
   * Whether ↑/↓ should navigate history for the current editor state.
   *
   * Empty input always enables history navigation. Non-empty input only enables it
   * when already in history-browsing mode and the cursor is at a line boundary,
   * so normal editing is not interrupted.
   */
  private shouldHandleNavigation(): boolean {
    if (this.text === "") return true;
    if (this.historyIndex !== -1) {
      return this.cursorPos === 0 || this.cursorPos === this.text.length;
    }
    return false;
  }

  invalidate(): void {
    // No cached state to clear
  }

  /** Clear input text */
  clear(): void {
    this.text = "";
    this.cursorPos = 0;
    this.requestRender();
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
