import { isPrintable, matchesKey } from "../framework/keys";
import type { Component } from "../framework/types";
import { t } from "../theme";

export interface ListPickerItem {
  label: string;
  description?: string;
  value: string;
}

export interface ListPickerOptions {
  title: string;
  items: ListPickerItem[];
  /** Index of initially selected item */
  selectedIndex?: number;
  /** Max visible items before scrolling */
  maxVisible?: number;
}

const DEFAULT_MAX_VISIBLE = 10;

export class ListPicker implements Component {
  private selectedIndex: number;
  private scrollOffset = 0;
  private filter = "";
  private filteredItems: ListPickerItem[];

  constructor(
    private options: ListPickerOptions,
    private onResult: (value: string | null) => void,
  ) {
    this.selectedIndex = options.selectedIndex ?? 0;
    this.filteredItems = [...options.items];
  }

  render(width: number): string[] {
    const items = this.filteredItems;
    const maxVisible = this.options.maxVisible ?? DEFAULT_MAX_VISIBLE;
    const visibleCount = Math.min(items.length, maxVisible);

    // Calculate dialog width based on content
    const maxLabelLen = items.length > 0 ? Math.max(...items.map((i) => i.label.length)) : 0;
    const maxDescLen = items.length > 0 ? Math.max(...items.map((i) => (i.description ?? "").length)) : 0;
    const itemWidth = maxLabelLen + (maxDescLen > 0 ? maxDescLen + 4 : 0);
    const titleWidth = this.options.title.length + 4;
    const contentWidth = Math.max(itemWidth + 6, titleWidth + 4); // 6 = "│ ▸ " prefix + " │" suffix
    const dialogWidth = Math.min(Math.max(contentWidth, 20), Math.floor(width * 0.8));
    const innerWidth = dialogWidth - 4; // "│ " + " │"

    const lines: string[] = [];

    // Top border with title
    const titleStr = ` ${this.options.title} `;
    const borderLen = Math.max(0, dialogWidth - 2 - titleStr.length);
    lines.push(`${t.bold}┌─${titleStr}${"─".repeat(borderLen)}┐${t.reset}`);

    // Filter line (shown when filter is active)
    if (this.filter) {
      const filterLine = `Filter: ${this.filter}`;
      const padding = " ".repeat(Math.max(0, innerWidth - filterLine.length));
      lines.push(`${t.bold}│${t.reset} ${t.dim}${filterLine}${padding}${t.reset} ${t.bold}│${t.reset}`);
      const sepFill = "─".repeat(Math.max(0, dialogWidth - 2));
      lines.push(`${t.bold}├${sepFill}┤${t.reset}`);
    }

    if (items.length === 0) {
      const noItems = this.filter ? "No matches" : "No items";
      const padding = " ".repeat(Math.max(0, innerWidth - noItems.length));
      lines.push(`${t.bold}│${t.reset} ${t.dim}${noItems}${padding}${t.reset} ${t.bold}│${t.reset}`);
    } else {
      // Ensure selected item is visible by adjusting scroll
      if (this.selectedIndex < this.scrollOffset) {
        this.scrollOffset = this.selectedIndex;
      } else if (this.selectedIndex >= this.scrollOffset + visibleCount) {
        this.scrollOffset = this.selectedIndex - visibleCount + 1;
      }

      // Scroll-up indicator
      if (this.scrollOffset > 0) {
        const upHint = `↑ ${this.scrollOffset} more`;
        const padding = " ".repeat(Math.max(0, innerWidth - upHint.length));
        lines.push(`${t.bold}│${t.reset} ${t.dim}${upHint}${padding}${t.reset} ${t.bold}│${t.reset}`);
      }

      // Render visible items
      const end = Math.min(items.length, this.scrollOffset + visibleCount);
      for (let i = this.scrollOffset; i < end; i++) {
        const item = items[i];
        const isSelected = i === this.selectedIndex;
        const marker = isSelected ? "▸" : " ";

        // Build item text with optional description
        const labelPart = item.label;
        let descPart = "";
        if (item.description) {
          const descSpace = innerWidth - item.label.length - 4; // marker+space prefix, 2-space gap
          if (descSpace > 0) {
            descPart =
              item.description.length > descSpace ? `${item.description.slice(0, descSpace - 1)}…` : item.description;
          }
        }

        // Calculate visible length for padding (without ANSI escapes)
        const visibleTextLen = 2 + labelPart.length + (descPart ? 2 + descPart.length : 0); // "▸ " + label + "  " + desc
        const padding = " ".repeat(Math.max(0, innerWidth - visibleTextLen));

        const descStr = descPart ? `  ${t.dim}${descPart}${t.reset}` : "";
        if (isSelected) {
          lines.push(`${t.bold}│${t.reset} ${t.accent}${marker} ${labelPart}${descStr}${t.reset}${padding} ${t.bold}│${t.reset}`);
        } else {
          lines.push(`${t.bold}│${t.reset} ${marker} ${labelPart}${descStr}${padding} ${t.bold}│${t.reset}`);
        }
      }

      // Scroll-down indicator
      const remaining = items.length - this.scrollOffset - visibleCount;
      if (remaining > 0) {
        const downHint = `↓ ${remaining} more`;
        const padding = " ".repeat(Math.max(0, innerWidth - downHint.length));
        lines.push(`${t.bold}│${t.reset} ${t.dim}${downHint}${padding}${t.reset} ${t.bold}│${t.reset}`);
      }
    }

    // Bottom border
    lines.push(`${t.bold}└${"─".repeat(dialogWidth - 2)}┘${t.reset}`);

    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up")) {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
      }
      return;
    }

    if (matchesKey(data, "down")) {
      if (this.selectedIndex < this.filteredItems.length - 1) {
        this.selectedIndex++;
      }
      return;
    }

    if (matchesKey(data, "enter")) {
      const item = this.filteredItems[this.selectedIndex];
      this.onResult(item ? item.value : null);
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onResult(null);
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (this.filter.length > 0) {
        this.filter = this.filter.slice(0, -1);
        this.applyFilter();
      }
      return;
    }

    // Type to filter
    if (isPrintable(data)) {
      this.filter += data;
      this.applyFilter();
    }
  }

  invalidate(): void {
    // No cached state to clear
  }

  private applyFilter(): void {
    const lower = this.filter.toLowerCase();
    this.filteredItems = this.options.items.filter(
      (i) => i.label.toLowerCase().includes(lower) || (i.description?.toLowerCase().includes(lower) ?? false),
    );
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
    this.scrollOffset = 0;
  }
}
