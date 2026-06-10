// @summary Single-line text input component with validation support
import { isPrintable, matchesKey } from "../framework/keys";
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "../framework/stdin-buffer";
import type { Component } from "../framework/types";
import { t } from "../theme";

export interface TextInputOptions {
  title: string;
  message?: string;
  placeholder?: string;
  /** When true, input is displayed as bullet characters */
  masked?: boolean;
  /** When true, renders as 2-line inline prompt instead of a box dialog */
  minimal?: boolean;
}

/** Text input prompt that can render inline or boxed. */
export class TextInput implements Component {
  private value = "";
  private cursorPos = 0;

  constructor(
    private options: TextInputOptions,
    private onResult: (value: string | null) => void,
  ) {}

  render(width: number): string[] {
    return this.options.minimal ? this.renderMinimal() : this.renderBox(width);
  }

  /** Minimal 2-line inline style — matches ApprovalDialog aesthetic */
  private renderMinimal(): string[] {
    const { message, placeholder, masked } = this.options;
    const label = message ?? this.options.title;

    // Line 1: ◆ <question>
    const header = `  ${t.warn}\u25c6${t.reset} ${t.dim}${label}${t.reset}`;

    // Line 2: › <input with cursor>  optional dim choices hint from placeholder
    const displayValue = masked ? "\u2022".repeat(this.value.length) : this.value;
    const before = displayValue.slice(0, this.cursorPos);
    const cursorChar = displayValue[this.cursorPos] ?? " ";
    const after = displayValue.slice(this.cursorPos + 1);
    const cursor = `${before}${t.inverse}${cursorChar}${t.reset}${after}`;
    // Show placeholder as dim hint beside the cursor when input is empty
    const field = this.value.length === 0 && placeholder ? `${t.dim}${placeholder}${t.reset}` : cursor;
    const hint = this.value.length > 0 && placeholder ? `  ${t.dim}${placeholder}${t.reset}` : "";

    const inputLine = `    ${t.accent}\u203a${t.reset} ${field}${hint}`;

    return [header, inputLine];
  }

  /** Original box-style dialog (used for wizard API key entry, etc.) */
  private renderBox(width: number): string[] {
    const { title, message, placeholder, masked } = this.options;

    // Calculate dialog width
    const minWidth = Math.max(title.length + 4, (message?.length ?? 0) + 4, 30);
    const dialogWidth = Math.min(minWidth + 6, Math.floor(width * 0.8));
    const innerWidth = dialogWidth - 4; // borders + padding

    const lines: string[] = [];

    // Top border with title
    const titleStr = ` ${title} `;
    const borderLen = Math.max(0, dialogWidth - 2 - titleStr.length);
    lines.push(`${t.bold}\u250c\u2500${titleStr}${"\u2500".repeat(borderLen)}\u2510${t.reset}`);

    // Message line(s)
    if (message) {
      const msgLines = this.wrapText(message, innerWidth);
      for (const ml of msgLines) {
        const padding = " ".repeat(Math.max(0, innerWidth - ml.length));
        lines.push(`${t.bold}\u2502${t.reset} ${ml}${padding} ${t.bold}\u2502${t.reset}`);
      }
      // Empty separator line
      lines.push(`${t.bold}\u2502${t.reset} ${" ".repeat(innerWidth)} ${t.bold}\u2502${t.reset}`);
    }

    // Input field
    const displayValue = masked ? "\u2022".repeat(this.value.length) : this.value;
    let fieldContent: string;

    if (this.value.length === 0 && placeholder) {
      fieldContent = `${t.dim}${placeholder}${t.reset}`;
      const fieldVisibleLen = placeholder.length;
      const fieldPadding = " ".repeat(Math.max(0, innerWidth - fieldVisibleLen));
      lines.push(`${t.bold}\u2502${t.reset} ${fieldContent}${fieldPadding} ${t.bold}\u2502${t.reset}`);
    } else {
      // Show input with cursor indicator
      const before = displayValue.slice(0, this.cursorPos);
      const cursorChar = displayValue[this.cursorPos] ?? " ";
      const after = displayValue.slice(this.cursorPos + 1);
      fieldContent = `${before}${t.inverse}${cursorChar}${t.reset}${after}`;

      const fieldVisibleLen = displayValue.length > this.cursorPos ? displayValue.length : displayValue.length + 1; // +1 for cursor space
      const fieldPadding = " ".repeat(Math.max(0, innerWidth - fieldVisibleLen));
      lines.push(`${t.bold}\u2502${t.reset} ${fieldContent}${fieldPadding} ${t.bold}\u2502${t.reset}`);
    }

    // Hint line
    const hint = "Enter to submit \u00b7 Escape to cancel";
    const hintPadding = " ".repeat(Math.max(0, innerWidth - hint.length));
    lines.push(`${t.bold}\u2502${t.reset} ${t.dim}${hint}${t.reset}${hintPadding} ${t.bold}\u2502${t.reset}`);

    // Bottom border
    lines.push(`${t.bold}\u2514${"\u2500".repeat(dialogWidth - 2)}\u2518${t.reset}`);

    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "bracketed_paste")) {
      const pasted = data.slice(BRACKETED_PASTE_START.length, data.length - BRACKETED_PASTE_END.length);
      const singleLinePaste = pasted.replace(/\r\n|\r|\n/g, "");
      if (singleLinePaste.length > 0) {
        this.insertText(singleLinePaste);
      }
      return;
    }

    // Submit
    if (matchesKey(data, "enter")) {
      this.onResult(this.value || null);
      return;
    }

    // Cancel
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onResult(null);
      return;
    }

    // Backspace
    if (matchesKey(data, "backspace")) {
      if (this.cursorPos > 0) {
        this.value = this.value.slice(0, this.cursorPos - 1) + this.value.slice(this.cursorPos);
        this.cursorPos--;
      }
      return;
    }

    // Delete
    if (matchesKey(data, "delete")) {
      if (this.cursorPos < this.value.length) {
        this.value = this.value.slice(0, this.cursorPos) + this.value.slice(this.cursorPos + 1);
      }
      return;
    }

    // Cursor movement
    if (matchesKey(data, "left")) {
      if (this.cursorPos > 0) this.cursorPos--;
      return;
    }
    if (matchesKey(data, "right")) {
      if (this.cursorPos < this.value.length) this.cursorPos++;
      return;
    }

    // Ctrl+A: move to start
    if (matchesKey(data, "ctrl+a")) {
      this.cursorPos = 0;
      return;
    }

    // Ctrl+E: move to end
    if (matchesKey(data, "ctrl+e")) {
      this.cursorPos = this.value.length;
      return;
    }

    // Ctrl+U: clear line
    if (matchesKey(data, "ctrl+u")) {
      this.value = "";
      this.cursorPos = 0;
      return;
    }

    // Ctrl+K: delete from cursor to end
    if (matchesKey(data, "ctrl+k")) {
      this.value = this.value.slice(0, this.cursorPos);
      return;
    }

    // Printable character
    if (isPrintable(data)) {
      this.insertText(data);
    }
  }

  invalidate(): void {
    // No cached state
  }

  /** Get the current input value (for testing) */
  getValue(): string {
    return this.value;
  }

  private insertText(text: string): void {
    this.value = this.value.slice(0, this.cursorPos) + text + this.value.slice(this.cursorPos);
    this.cursorPos += text.length;
  }

  private wrapText(text: string, maxWidth: number): string[] {
    if (text.length <= maxWidth) return [text];

    const lines: string[] = [];
    let remaining = text;

    while (remaining.length > maxWidth) {
      let breakIdx = remaining.lastIndexOf(" ", maxWidth);
      if (breakIdx <= 0) breakIdx = maxWidth;
      lines.push(remaining.slice(0, breakIdx));
      remaining = remaining.slice(breakIdx).trimStart();
    }
    if (remaining) lines.push(remaining);

    return lines;
  }
}
