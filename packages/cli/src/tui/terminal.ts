export class Terminal {
  private originalRawMode: boolean | undefined;

  get columns(): number {
    return process.stdout.columns ?? 80;
  }

  get rows(): number {
    return process.stdout.rows ?? 24;
  }

  start(onInput: (data: Buffer) => void, onResize: () => void): void {
    if (process.stdin.isTTY) {
      this.originalRawMode = process.stdin.isRaw;
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", onInput);
    process.stdout.on("resize", onResize);
  }

  stop(): void {
    if (process.stdin.isTTY && this.originalRawMode !== undefined) {
      process.stdin.setRawMode(this.originalRawMode);
    }
    process.stdin.pause();
    process.stdin.removeAllListeners("data");
    process.stdout.removeAllListeners("resize");
  }

  write(text: string): void {
    process.stdout.write(text);
  }

  writeLine(text: string): void {
    process.stdout.write(`${text}\n`);
  }

  clearLine(): void {
    process.stdout.write("\x1b[2K\r");
  }
}
