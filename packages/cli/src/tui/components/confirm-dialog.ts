import { matchesKey } from "../framework/keys";
import type { Component } from "../framework/types";
import { t } from "../theme";

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/**
 * Simple yes/no dialog rendered as an overlay.
 * Foundation for Phase 4b's approval dialog.
 */
export class ConfirmDialog implements Component {
  private selectedIndex = 0; // 0 = confirm, 1 = cancel
  private confirmLabel: string;
  private cancelLabel: string;

  constructor(
    private options: ConfirmDialogOptions,
    private onResult: (confirmed: boolean) => void,
  ) {
    this.confirmLabel = options.confirmLabel ?? "Yes";
    this.cancelLabel = options.cancelLabel ?? "No";
  }

  render(width: number): string[] {
    const title = this.options.title;
    const message = this.options.message;

    // Calculate dialog width
    const contentWidth = Math.max(
      title.length + 4,
      message.length + 4,
      this.confirmLabel.length + this.cancelLabel.length + 12,
    );
    const dialogWidth = Math.min(contentWidth, Math.floor(width * 0.8));
    const innerWidth = dialogWidth - 4; // borders + padding

    // Build dialog lines
    const lines: string[] = [];

    // Top border with title
    const titleStr = ` ${title} `;
    const borderLen = Math.max(0, dialogWidth - 2 - titleStr.length);
    lines.push(`${t.bold}\u250c\u2500${titleStr}${"\u2500".repeat(borderLen)}\u2510${t.reset}`);

    // Message line(s)
    const msgLines = this.wrapText(message, innerWidth);
    for (const ml of msgLines) {
      const padding = " ".repeat(Math.max(0, innerWidth - ml.length));
      lines.push(`${t.bold}\u2502${t.reset} ${ml}${padding} ${t.bold}\u2502${t.reset}`);
    }

    // Empty line
    lines.push(`${t.bold}\u2502${t.reset} ${" ".repeat(innerWidth)} ${t.bold}\u2502${t.reset}`);

    // Buttons line
    const confirmStr = this.selectedIndex === 0 ? `${t.inverse} ${this.confirmLabel} ${t.reset}` : ` ${this.confirmLabel} `;
    const cancelStr = this.selectedIndex === 1 ? `${t.inverse} ${this.cancelLabel} ${t.reset}` : ` ${this.cancelLabel} `;

    const buttonsText = `  ${confirmStr}    ${cancelStr}`;
    // Approximate visible width for padding
    const buttonsVisibleLen = 4 + this.confirmLabel.length + 4 + this.cancelLabel.length + 2;
    const btnPadding = " ".repeat(Math.max(0, innerWidth - buttonsVisibleLen));
    lines.push(`${t.bold}\u2502${t.reset} ${buttonsText}${btnPadding} ${t.bold}\u2502${t.reset}`);

    // Bottom border
    lines.push(`${t.bold}\u2514${"\u2500".repeat(dialogWidth - 2)}\u2518${t.reset}`);

    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "left") || matchesKey(data, "tab")) {
      this.selectedIndex = this.selectedIndex === 0 ? 1 : 0;
      return;
    }

    if (matchesKey(data, "right")) {
      this.selectedIndex = this.selectedIndex === 0 ? 1 : 0;
      return;
    }

    if (matchesKey(data, "enter")) {
      this.onResult(this.selectedIndex === 0);
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onResult(false);
      return;
    }

    // y/n shortcuts
    if (data === "y" || data === "Y") {
      this.onResult(true);
      return;
    }
    if (data === "n" || data === "N") {
      this.onResult(false);
    }
  }

  invalidate(): void {
    // No cached state
  }

  private wrapText(text: string, maxWidth: number): string[] {
    if (text.length <= maxWidth) return [text];

    const lines: string[] = [];
    let remaining = text;

    while (remaining.length > maxWidth) {
      // Find last space within maxWidth
      let breakIdx = remaining.lastIndexOf(" ", maxWidth);
      if (breakIdx <= 0) breakIdx = maxWidth;
      lines.push(remaining.slice(0, breakIdx));
      remaining = remaining.slice(breakIdx).trimStart();
    }
    if (remaining) lines.push(remaining);

    return lines;
  }
}
