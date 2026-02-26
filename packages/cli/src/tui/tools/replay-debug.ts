/**
 * TUI debug log replayer.
 *
 * Reads a JSONL debug log and replays each render through TerminalSim,
 * printing the screen state after each render so you can see exactly
 * where the cursor ended up and whether content duplicated.
 *
 * Usage:
 *   DILIGENT_TUI_DEBUG=/tmp/tui.jsonl diligent   # capture
 *   bun packages/cli/src/tui/tools/replay-debug.ts /tmp/tui.jsonl
 *   bun packages/cli/src/tui/tools/replay-debug.ts /tmp/tui.jsonl --from=10 --to=20
 *   bun packages/cli/src/tui/tools/replay-debug.ts /tmp/tui.jsonl --anomalies-only
 */

import { readFileSync } from "node:fs";
import type { DebugEntry, RenderEntry } from "../framework/debug-logger";

// ---------------------------------------------------------------------------
// TerminalSim — same parser as tests
// ---------------------------------------------------------------------------

class TerminalSim {
  screen: string[] = [];
  cursorRow = 0;
  cursorCol = 0;

  constructor(
    public columns = 120,
    public rows = 40,
  ) {}

  feed(data: string): void {
    data = data.replace(/\x1b\[\?2026[hl]/g, "");
    let i = 0;
    while (i < data.length) {
      if (data[i] === "\x1b") {
        const seq = this._parseEscape(data, i);
        this._applyEscape(seq);
        i += seq.length;
      } else if (data[i] === "\r") {
        this.cursorCol = 0;
        i++;
      } else if (data[i] === "\n") {
        this.cursorRow++;
        while (this.screen.length <= this.cursorRow) this.screen.push("");
        i++;
      } else if (data.charCodeAt(i) >= 32) {
        this._writeChar(data[i]);
        i++;
      } else {
        i++;
      }
    }
  }

  private _writeChar(ch: string): void {
    while (this.screen.length <= this.cursorRow) this.screen.push("");
    const row = this.screen[this.cursorRow];
    const before = row.slice(0, this.cursorCol);
    const after = row.slice(this.cursorCol + 1);
    this.screen[this.cursorRow] = before + ch + after;
    this.cursorCol++;
  }

  private _parseEscape(data: string, start: number): string {
    if (start + 1 >= data.length) return data[start];
    const next = data[start + 1];
    if (next === "[") {
      let i = start + 2;
      while (i < data.length && !data[i].match(/[A-Za-z]/)) i++;
      if (i < data.length) i++;
      return data.slice(start, i);
    }
    if (next === "_") {
      let i = start + 2;
      while (i < data.length && data[i] !== "\x07") i++;
      if (i < data.length) i++;
      return data.slice(start, i);
    }
    return data.slice(start, start + 2);
  }

  private _applyEscape(seq: string): void {
    const csi = seq.match(/^\x1b\[(\??[0-9;]*)([A-Za-z])$/);
    if (!csi) return;
    const params = csi[1].replace("?", "");
    const cmd = csi[2];
    const n = parseInt(params || "1", 10) || 1;
    switch (cmd) {
      case "A": this.cursorRow = Math.max(0, this.cursorRow - n); break;
      case "B":
        this.cursorRow += n;
        while (this.screen.length <= this.cursorRow) this.screen.push("");
        break;
      case "C": this.cursorCol += n; break;
      case "D": this.cursorCol = Math.max(0, this.cursorCol - n); break;
      case "H": // cursor position
        if (params === "" || params === "1;1") {
          this.cursorRow = 0;
          this.cursorCol = 0;
        } else if (params.includes(";")) {
          const parts = params.split(";");
          this.cursorRow = Math.max(0, (parseInt(parts[0] || "1", 10) || 1) - 1);
          this.cursorCol = Math.max(0, (parseInt(parts[1] || "1", 10) || 1) - 1);
        }
        break;
      case "J": // erase display
        if (n === 2) {
          this.screen = Array(this.rows).fill("");
        }
        break;
      case "K":
        while (this.screen.length <= this.cursorRow) this.screen.push("");
        this.screen[this.cursorRow] = "";
        this.cursorCol = 0;
        break;
    }
  }

  printState(label: string): void {
    const nonEmpty = this.screen
      .map((line, i) => ({ i, line }))
      .filter(({ line }) => line.length > 0);

    console.log(`\n─── ${label} ───`);
    for (const { i, line } of nonEmpty) {
      const isCursor = i === this.cursorRow;
      const marker = isCursor ? "→" : " ";
      console.log(`  ${marker} [${i}] ${JSON.stringify(line)}`);
    }
    if (nonEmpty.length === 0) console.log("  (empty screen)");
  }
}

// Strip ANSI escape codes for comparison
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: bun replay-debug.ts <path-to-tui.jsonl> [--from=N] [--to=N] [--anomalies-only]");
  process.exit(1);
}

const rawLines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
const entries: DebugEntry[] = rawLines.map((l, i) => {
  try {
    return JSON.parse(l) as DebugEntry;
  } catch {
    console.error(`Line ${i + 1}: invalid JSON`);
    process.exit(1);
  }
});

const renderEntries = entries.filter((e): e is RenderEntry => e.type === "render");
const agentEntries = entries.filter((e) => e.type === "agent_event");

console.log(`Total entries: ${entries.length} (${renderEntries.length} renders, ${agentEntries.length} agent events)`);

const sim = new TerminalSim();
let lastAgentIdx = 0;

// Render index (1-based) for display, independent of seq
const anomaliesOnly = process.argv.includes("--anomalies-only");
const showFrom = parseInt(process.argv.find((a) => a.startsWith("--from="))?.split("=")[1] ?? "1", 10);
const showTo = parseInt(process.argv.find((a) => a.startsWith("--to="))?.split("=")[1] ?? String(renderEntries.length), 10);

let renderIdx = 0;
const pendingEvents: string[] = [];

for (const entry of renderEntries) {
  renderIdx++;

  // Collect agent events that came before this render
  while (lastAgentIdx < agentEntries.length && agentEntries[lastAgentIdx].ts <= entry.ts) {
    const ae = agentEntries[lastAgentIdx];
    const evType = (ae.event as { type?: string })?.type ?? "unknown";
    pendingEvents.push(`  [event] ${evType}`);
    lastAgentIdx++;
  }

  // Apply full redraw output to sim
  sim.feed(entry.fullOutput);

  if (renderIdx < showFrom || renderIdx > showTo) {
    pendingEvents.length = 0;
    continue;
  }

  // Anomaly detection
  // 1. Cursor row drift: sim.cursorRow should equal entry.cursorRow
  const cursorRowDrift = sim.cursorRow !== entry.cursorRow;

  // 2. Content at cursor should match (strip ANSI for comparison)
  const expectedContent = stripAnsi(entry.cleanLines[entry.cursorRow] ?? "");
  const actualContent = sim.screen[sim.cursorRow] ?? "";
  const contentMismatch = entry.cursorRow !== -1 && expectedContent !== actualContent;

  // 3. Duplicate non-empty lines
  const nonEmpty = sim.screen.filter((l) => l.trim().length > 0);
  const hasDuplicates = nonEmpty.length !== new Set(nonEmpty).size;

  const anomalies: string[] = [];
  if (cursorRowDrift) {
    anomalies.push(`CURSOR ROW DRIFT: expected=${entry.cursorRow} actual=${sim.cursorRow}`);
  }
  if (contentMismatch) {
    anomalies.push(`CONTENT MISMATCH at cursor: expected="${expectedContent}" actual="${actualContent}"`);
  }
  if (hasDuplicates) {
    const dups = nonEmpty.filter((l, i, arr) => arr.indexOf(l) !== i);
    anomalies.push(`DUPLICATE LINES: ${JSON.stringify(dups.slice(0, 3))}`);
  }

  if (anomaliesOnly && anomalies.length === 0) {
    pendingEvents.length = 0;
    continue;
  }

  // Print pending events
  for (const e of pendingEvents) console.log(e);
  pendingEvents.length = 0;

  const label = [
    `Render ${renderIdx}/${renderEntries.length}`,
    `seq=${entry.seq}`,
    `cursor=${entry.cursorRow},${entry.cursorCol}`,
    `lines=${entry.cleanLines.length}`,
    anomalies.length ? `⚠ ${anomalies.join("; ")}` : "✓",
  ].join("  ");

  sim.printState(label);
}

// Remaining events
for (const e of pendingEvents) console.log(e);

console.log(`\nDone. ${renderEntries.length} renders replayed.`);
