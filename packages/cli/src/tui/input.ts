export const Keys = {
  ENTER: "\r",
  CTRL_C: "\x03",
  CTRL_D: "\x04",
  BACKSPACE: "\x7f",
  ESCAPE: "\x1b",
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  RIGHT: "\x1b[C",
  LEFT: "\x1b[D",
} as const;

export function matchesKey(data: Buffer | string, key: string): boolean {
  const str = typeof data === "string" ? data : data.toString("utf-8");
  return str === key;
}

export class InputBuffer {
  text = "";
  cursorPos = 0;

  insert(char: string): void {
    this.text =
      this.text.slice(0, this.cursorPos) + char + this.text.slice(this.cursorPos);
    this.cursorPos += char.length;
  }

  backspace(): void {
    if (this.cursorPos > 0) {
      this.text =
        this.text.slice(0, this.cursorPos - 1) + this.text.slice(this.cursorPos);
      this.cursorPos--;
    }
  }

  clear(): string {
    const text = this.text;
    this.text = "";
    this.cursorPos = 0;
    return text;
  }

  moveLeft(): void {
    if (this.cursorPos > 0) this.cursorPos--;
  }

  moveRight(): void {
    if (this.cursorPos < this.text.length) this.cursorPos++;
  }
}
