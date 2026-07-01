// @summary Doom-loop detection helpers for repeated tool-call patterns

export interface DoomLoopDetection {
  detected: boolean;
  patternLength?: number;
  toolName?: string;
}

export interface DoomLoopTracker {
  signatures: string[];
  window: number;
}

export class DoomLoopDetector {
  private tracker: DoomLoopTracker;

  constructor(window = 24) {
    this.tracker = createDoomLoopTracker(window);
  }

  record(toolName: string, input: Record<string, unknown>): void {
    recordDoomLoopToolCall(this.tracker, toolName, input);
  }

  check(): DoomLoopDetection {
    return detectDoomLoop(this.tracker);
  }
}

function createDoomLoopTracker(window = 24): DoomLoopTracker {
  return { signatures: [], window };
}

function recordDoomLoopToolCall(tracker: DoomLoopTracker, toolName: string, input: Record<string, unknown>): void {
  tracker.signatures.push(`${toolName}\0${JSON.stringify(input)}`);
  if (tracker.signatures.length > tracker.window) tracker.signatures.shift();
}

function detectDoomLoop(tracker: DoomLoopTracker): DoomLoopDetection {
  for (let patternLength = 1; patternLength <= maxPatternLength(tracker.window); patternLength++) {
    const repeats = 3;
    const needed = patternLength * repeats;
    if (tracker.signatures.length < needed) continue;
    const tail = tracker.signatures.slice(-needed);
    const pattern = tail.slice(0, patternLength);
    const detected = tail.every((signature, index) => signature === pattern[index % patternLength]);
    if (detected) {
      const toolName = pattern[0].split("\0")[0];
      return { detected: true, patternLength, toolName };
    }
  }
  return { detected: false };
}

function maxPatternLength(window: number): number {
  return Math.floor(window / 3);
}
