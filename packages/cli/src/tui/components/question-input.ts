// @summary Combined question input — supports single select, multi-select checkboxes, and always-on free-text
import { isPrintable, matchesKey } from "../framework/keys";
import type { Component } from "../framework/types";
import { t } from "../theme";

export interface QuestionInputOption {
  label: string;
  description: string;
  value?: string;
}

export interface QuestionInputOptions {
  header?: string;
  question: string;
  options?: QuestionInputOption[];
  allowMultiple?: boolean;
  masked?: boolean;
  placeholder?: string;
}

export type QuestionInputResult = string | string[] | null;

export class QuestionInput implements Component {
  private selectedIndex = 0;
  private value = "";
  private cursorPos = 0;
  private readonly opts: QuestionInputOption[];
  private readonly allowMultiple: boolean;
  private readonly selected = new Set<number>();

  constructor(
    private options: QuestionInputOptions,
    private onResult: (value: QuestionInputResult) => void,
  ) {
    this.opts = options.options ?? [];
    this.allowMultiple = Boolean(options.allowMultiple);
  }

  private get hasInputRow(): boolean {
    return true;
  }

  private get inputRowIndex(): number {
    return this.opts.length;
  }

  private get rowCount(): number {
    return this.opts.length + (this.hasInputRow ? 1 : 0);
  }

  private get onInputRow(): boolean {
    return this.hasInputRow && this.selectedIndex === this.inputRowIndex;
  }

  render(_width: number): string[] {
    const { header, question } = this.options;
    const headerChip = header ? `${t.accent}[${header}]${t.reset} ` : "";
    const headerLine = `  ${t.warn}◆${t.reset} ${headerChip}${t.dim}${question}${t.reset}`;
    const rows: string[] = [];

    for (let i = 0; i < this.opts.length; i++) {
      const isFocused = i === this.selectedIndex;
      const isChecked = this.selected.has(i);
      const marker = isFocused ? `${t.accent}▸${t.reset}` : " ";
      const checkbox = this.allowMultiple ? (isChecked ? "[x]" : "[ ]") : isChecked ? "(●)" : "( )";
      const { label, description } = this.opts[i];
      const labelPart = isFocused ? `${t.bold}${label}${t.reset}` : label;
      const descPart = description ? `  ${t.dim}· ${description}${t.reset}` : "";
      rows.push(`    ${marker} ${checkbox} ${labelPart}${descPart}`);
    }

    if (this.hasInputRow) {
      const { masked } = this.options;
      const displayValue = masked ? "•".repeat(this.value.length) : this.value;
      const before = displayValue.slice(0, this.cursorPos);
      const cursorChar = displayValue[this.cursorPos] ?? " ";
      const after = displayValue.slice(this.cursorPos + 1);
      const placeholder =
        this.options.placeholder ?? (this.opts.length > 0 ? "or type a custom answer…" : "type your answer…");

      if (this.onInputRow) {
        const field =
          this.value.length === 0
            ? `${t.dim}${placeholder}${t.reset}`
            : `${before}${t.inverse}${cursorChar}${t.reset}${after}`;
        const marker = `${t.accent}▸${t.reset}`;
        rows.push(`    ${marker} ${field}`);
      } else {
        const marker = " ";
        const display =
          displayValue.length > 0 ? `${t.dim}${displayValue}${t.reset}` : `${t.dim}${placeholder}${t.reset}`;
        rows.push(`    ${marker} ${display}`);
      }
    }

    if (this.allowMultiple) {
      rows.push(
        `    ${t.dim}Tip: Space/Enter to toggle, then move to custom input and press Enter to submit.${t.reset}`,
      );
    }

    return [headerLine, ...rows];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up")) {
      if (this.selectedIndex > 0) this.selectedIndex--;
      return;
    }
    if (matchesKey(data, "down")) {
      if (this.selectedIndex < this.rowCount - 1) this.selectedIndex++;
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onResult(null);
      return;
    }

    if (data === " " && !this.onInputRow && this.allowMultiple) {
      this.toggleCurrentOption();
      return;
    }

    if (matchesKey(data, "enter")) {
      if (this.allowMultiple && !this.onInputRow) {
        this.toggleCurrentOption();
        return;
      }
      this.submit();
      return;
    }

    if (!this.onInputRow) {
      if (isPrintable(data) && this.hasInputRow) {
        this.selectedIndex = this.inputRowIndex;
        this.value = data;
        this.cursorPos = 1;
      }
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (this.cursorPos > 0) {
        this.value = this.value.slice(0, this.cursorPos - 1) + this.value.slice(this.cursorPos);
        this.cursorPos--;
      }
      return;
    }
    if (matchesKey(data, "delete")) {
      if (this.cursorPos < this.value.length) {
        this.value = this.value.slice(0, this.cursorPos) + this.value.slice(this.cursorPos + 1);
      }
      return;
    }
    if (matchesKey(data, "left")) {
      if (this.cursorPos > 0) this.cursorPos--;
      return;
    }
    if (matchesKey(data, "right")) {
      if (this.cursorPos < this.value.length) this.cursorPos++;
      return;
    }
    if (matchesKey(data, "ctrl+a")) {
      this.cursorPos = 0;
      return;
    }
    if (matchesKey(data, "ctrl+e")) {
      this.cursorPos = this.value.length;
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.value = "";
      this.cursorPos = 0;
      return;
    }
    if (matchesKey(data, "ctrl+k")) {
      this.value = this.value.slice(0, this.cursorPos);
      return;
    }
    if (isPrintable(data)) {
      this.value = this.value.slice(0, this.cursorPos) + data + this.value.slice(this.cursorPos);
      this.cursorPos++;
    }
  }

  private toggleCurrentOption(): void {
    const idx = this.selectedIndex;
    if (idx < 0 || idx >= this.opts.length) return;
    if (this.selected.has(idx)) {
      this.selected.delete(idx);
      return;
    }
    this.selected.add(idx);
  }

  private submit(): void {
    if (this.onInputRow) {
      if (this.allowMultiple) {
        const labels = [...this.selected]
          .sort((a, b) => a - b)
          .map((idx) => this.opts[idx]?.value ?? this.opts[idx]?.label)
          .filter(Boolean);
        if (this.value.length > 0) labels.push(this.value);
        this.onResult(labels.length > 0 ? labels : null);
        return;
      }
      this.onResult(this.value.length > 0 ? this.value : null);
      return;
    }

    if (this.selectedIndex < 0 || this.selectedIndex >= this.opts.length) {
      this.onResult(null);
      return;
    }

    if (this.allowMultiple) {
      this.toggleCurrentOption();
      return;
    }

    this.onResult(this.opts[this.selectedIndex].value ?? this.opts[this.selectedIndex].label);
  }

  invalidate(): void {}
}
