const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL_MS = 80;

/**
 * Braille spinner for indicating tool execution in progress. (D049)
 */
export class Spinner {
  private frameIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private message = "";
  private onRender: (frame: string) => void;

  constructor(onRender: (frame: string) => void) {
    this.onRender = onRender;
  }

  start(message: string): void {
    this.stop(); // Stop any existing spinner
    this.message = message;
    this.frameIndex = 0;
    this.onRender(this.render());
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % BRAILLE_FRAMES.length;
      this.onRender(this.render());
    }, FRAME_INTERVAL_MS);
  }

  setMessage(message: string): void {
    this.message = message;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  private render(): string {
    return `\x1b[36m${BRAILLE_FRAMES[this.frameIndex]}\x1b[39m ${this.message}`;
  }
}
