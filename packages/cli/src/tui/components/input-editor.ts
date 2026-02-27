import type { CompletionItem } from "../commands/registry";
import { isPrintable, matchesKey } from "../framework/keys";
import type { Component, Focusable } from "../framework/types";
import { CURSOR_MARKER } from "../framework/types";

const MAX_HISTORY_SIZE = 100;
const MAX_VISIBLE_COMPLETIONS = 8;

export interface InputEditorOptions {
  prompt?: string;
  onSubmit?: (text: string) => void;
  onCancel?: () => void;
  onExit?: () => void;
  /** Autocomplete provider for slash commands */
  onComplete?: (partial: string) => string[];
  /** Detailed autocomplete provider for inline popup */
  onCompleteDetailed?: (partial: string) => CompletionItem[];
}

export class InputEditor implements Component, Focusable {
  focused = false;
  private text = "";
  private cursorPos = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private historyDraft = "";

  // Completion popup state
  private completionItems: CompletionItem[] = [];
  private completionIndex = 0;
  private completionVisible = false;
  private completionScrollOffset = 0;

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

    const inputLine = `\x1b[1;2m${prompt}\x1b[0m${displayBefore}${CURSOR_MARKER}${displayAfter}`;

    // Render completion popup below the input
    const popupLines = this.renderCompletionPopup(width);

    return ["", sep, inputLine, sep, ...popupLines];
  }

  /** Returns true if the key was consumed by the editor, false if the caller should handle it. */
  handleInput(data: string): boolean {
    // Escape closes popup without other side effects
    if (matchesKey(data, "escape")) {
      if (this.completionVisible) {
        this.completionVisible = false;
        this.completionItems = [];
        this.requestRender();
        return true;
      }
      return false;
    }

    if (matchesKey(data, "enter")) {
      // When popup is visible, accept the selected item and submit
      if (this.completionVisible && this.completionItems.length > 0) {
        const selected = this.completionItems[this.completionIndex];
        const submitText = `/${selected.name}`;
        this.completionVisible = false;
        this.completionItems = [];
        this.addToHistory(submitText);
        this.text = "";
        this.cursorPos = 0;
        this.historyIndex = -1;
        this.requestRender();
        this.options.onSubmit?.(submitText);
        return true;
      }
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
      this.updateCompletion();
      this.requestRender();
      return true;
    }

    // Ctrl+U — delete to start of line
    if (matchesKey(data, "ctrl+u")) {
      this.text = this.text.slice(this.cursorPos);
      this.cursorPos = 0;
      this.updateCompletion();
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
      this.updateCompletion();
      this.requestRender();
      return true;
    }

    // Backspace
    if (matchesKey(data, "backspace")) {
      if (this.cursorPos > 0) {
        this.text = this.text.slice(0, this.cursorPos - 1) + this.text.slice(this.cursorPos);
        this.cursorPos--;
        this.updateCompletion();
        this.requestRender();
      }
      return true;
    }

    // Delete
    if (matchesKey(data, "delete")) {
      if (this.cursorPos < this.text.length) {
        this.text = this.text.slice(0, this.cursorPos) + this.text.slice(this.cursorPos + 1);
        this.updateCompletion();
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

    // Arrow up/down — completion navigation takes priority, then history
    if (matchesKey(data, "up")) {
      if (this.completionVisible) {
        this.completionIndex = Math.max(0, this.completionIndex - 1);
        this.scrollCompletionIntoView();
        this.requestRender();
        return true;
      }
      if (!this.shouldHandleNavigation()) return false;
      this.navigateHistory(1);
      return true;
    }

    if (matchesKey(data, "down")) {
      if (this.completionVisible) {
        this.completionIndex = Math.min(this.completionItems.length - 1, this.completionIndex + 1);
        this.scrollCompletionIntoView();
        this.requestRender();
        return true;
      }
      if (!this.shouldHandleNavigation()) return false;
      this.navigateHistory(-1);
      return true;
    }

    // Tab — accept completion popup selection, or fall back to prefix completion
    if (matchesKey(data, "tab")) {
      if (this.completionVisible && this.completionItems.length > 0) {
        const selected = this.completionItems[this.completionIndex];
        this.text = `/${selected.name} `;
        this.cursorPos = this.text.length;
        this.updateCompletion();
        this.requestRender();
        return true;
      }
      if (this.text.startsWith("/") && !this.text.startsWith("//") && this.options.onComplete) {
        const partial = this.text.slice(1).split(" ")[0]; // text after / up to first space
        if (!this.text.includes(" ")) {
          // Only autocomplete when no space yet (still typing command name)
          const candidates = this.options.onComplete(partial);
          if (candidates.length === 1) {
            this.text = `/${candidates[0]} `;
            this.cursorPos = this.text.length;
          } else if (candidates.length > 1) {
            const common = this.commonPrefix(candidates);
            if (common.length > partial.length) {
              this.text = `/${common}`;
              this.cursorPos = this.text.length;
            }
          }
          this.requestRender();
        }
      }
      return true;
    }

    // Printable character
    if (isPrintable(data)) {
      this.text = this.text.slice(0, this.cursorPos) + data + this.text.slice(this.cursorPos);
      this.cursorPos += data.length;
      this.updateCompletion();
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
    this.updateCompletion();
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
    if (this.history.length > MAX_HISTORY_SIZE) {
      this.history.shift();
    }
  }

  private commonPrefix(strings: string[]): string {
    if (strings.length === 0) return "";
    let prefix = strings[0];
    for (let i = 1; i < strings.length; i++) {
      while (!strings[i].startsWith(prefix)) {
        prefix = prefix.slice(0, -1);
        if (prefix === "") return "";
      }
    }
    return prefix;
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

  /** Update completion popup state based on current text */
  private updateCompletion(): void {
    if (
      this.text.startsWith("/") &&
      !this.text.startsWith("//") &&
      !this.text.includes(" ") &&
      this.options.onCompleteDetailed
    ) {
      const partial = this.text.slice(1);
      this.completionItems = this.options.onCompleteDetailed(partial);
      this.completionVisible = this.completionItems.length > 0;
      this.completionIndex = 0;
      this.completionScrollOffset = 0;
    } else {
      this.completionVisible = false;
      this.completionItems = [];
    }
  }

  /** Ensure the selected completion index is within the visible scroll window */
  private scrollCompletionIntoView(): void {
    if (this.completionIndex < this.completionScrollOffset) {
      this.completionScrollOffset = this.completionIndex;
    } else if (this.completionIndex >= this.completionScrollOffset + MAX_VISIBLE_COMPLETIONS) {
      this.completionScrollOffset = this.completionIndex - MAX_VISIBLE_COMPLETIONS + 1;
    }
  }

  /** Render the completion popup lines (empty array if hidden) */
  private renderCompletionPopup(width: number): string[] {
    if (!this.completionVisible || this.completionItems.length === 0) {
      return [];
    }

    const lines: string[] = [];
    const total = this.completionItems.length;
    const visibleCount = Math.min(total, MAX_VISIBLE_COMPLETIONS);
    const start = this.completionScrollOffset;
    const end = start + visibleCount;

    // "↑ N more" indicator
    if (start > 0) {
      lines.push(`\x1b[2m  \u2191 ${start} more\x1b[0m`);
    }

    // Find the longest name for alignment
    const visibleItems = this.completionItems.slice(start, end);
    const maxNameLen = Math.max(...visibleItems.map((item) => item.name.length));

    for (let i = start; i < end; i++) {
      const item = this.completionItems[i];
      const isSelected = i === this.completionIndex;
      const marker = isSelected ? "\x1b[36m \u25b8 " : "   ";
      const name = item.name.padEnd(maxNameLen);
      const desc = item.description;

      // Truncate description to fit width (marker=3 + name + gap=3 + desc)
      const descSpace = width - 3 - maxNameLen - 3;
      const truncDesc = descSpace > 4 ? (desc.length > descSpace ? `${desc.slice(0, descSpace - 1)}\u2026` : desc) : "";

      if (isSelected) {
        lines.push(`${marker}${name}\x1b[0m   \x1b[2m${truncDesc}\x1b[0m`);
      } else {
        lines.push(`${marker}${name}   \x1b[2m${truncDesc}\x1b[0m`);
      }
    }

    // "↓ N more" indicator
    const remaining = total - end;
    if (remaining > 0) {
      lines.push(`\x1b[2m  \u2193 ${remaining} more\x1b[0m`);
    }

    return lines;
  }
}
