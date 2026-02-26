import { appendFileSync, writeFileSync } from "node:fs";

/**
 * TUI debug logger. Enabled by setting DILIGENT_TUI_DEBUG=/path/to/file.jsonl
 *
 * Records render snapshots so you can inspect exactly what the renderer
 * was doing (lines, diff output, cursor state) without needing a real TTY.
 *
 * Usage:
 *   DILIGENT_TUI_DEBUG=/tmp/tui.jsonl diligent
 *   cat /tmp/tui.jsonl | bunx tsx packages/cli/src/tui/tools/replay-debug.ts
 */

export interface RenderEntry {
  type: "render";
  seq: number;
  ts: number;
  termCols: number;
  termRows: number;
  newLines: string[];
  cleanLines: string[];
  cursorRow: number;
  cursorCol: number;
  /** Full redraw bytes sent to writeSynchronized */
  fullOutput: string;
}

export interface EventEntry {
  type: "agent_event";
  seq: number;
  ts: number;
  event: unknown;
}

export type DebugEntry = RenderEntry | EventEntry;

export class TUIDebugLogger {
  private path: string;
  private seq = 0;
  private enabled: boolean;

  constructor(path: string | undefined) {
    this.path = path ?? "";
    this.enabled = !!path;
    if (this.enabled) {
      // Truncate / create the file at startup
      try {
        writeFileSync(this.path, "");
      } catch {
        this.enabled = false;
      }
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  logRender(entry: Omit<RenderEntry, "type" | "seq" | "ts">): void {
    if (!this.enabled) return;
    this._write({
      type: "render",
      seq: ++this.seq,
      ts: Date.now(),
      ...entry,
    });
  }

  logAgentEvent(event: unknown): void {
    if (!this.enabled) return;
    this._write({
      type: "agent_event",
      seq: ++this.seq,
      ts: Date.now(),
      event,
    });
  }

  private _write(entry: DebugEntry): void {
    try {
      appendFileSync(this.path, JSON.stringify(entry) + "\n");
    } catch {
      // Silently ignore write errors
    }
  }
}

/** Singleton logger — initialized once from env var */
export const debugLogger = new TUIDebugLogger(process.env.DILIGENT_TUI_DEBUG);
