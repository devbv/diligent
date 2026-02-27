export interface LoopDetectionResult {
  detected: boolean;
  patternLength?: number;
  toolName?: string;
}

export class LoopDetector {
  private signatures: string[] = [];
  private readonly window: number;

  constructor(window = 10) {
    this.window = window;
  }

  record(toolName: string, input: Record<string, unknown>): void {
    this.signatures.push(`${toolName}\0${JSON.stringify(input)}`);
    if (this.signatures.length > this.window) this.signatures.shift();
  }

  check(): LoopDetectionResult {
    for (const len of [1, 2, 3]) {
      const repeats = 3;
      const needed = len * repeats;
      if (this.signatures.length < needed) continue;
      const tail = this.signatures.slice(-needed);
      const pattern = tail.slice(0, len);
      const isLoop = tail.every((sig, i) => sig === pattern[i % len]);
      if (isLoop) {
        const firstName = pattern[0].split("\0")[0];
        return { detected: true, patternLength: len, toolName: firstName };
      }
    }
    return { detected: false };
  }
}
