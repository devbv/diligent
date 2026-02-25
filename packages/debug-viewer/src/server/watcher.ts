import { type FSWatcher, readdirSync, watch } from "fs";
import { join } from "path";
import type { SessionEntry } from "../shared/types.js";
import { IncrementalParser } from "./parser.js";

export interface WatcherEvents {
  onNewEntries: (sessionId: string, entries: SessionEntry[]) => void;
  onNewSession: (sessionId: string) => void;
}

export class SessionWatcher {
  private watcher: FSWatcher | null = null;
  private parsers = new Map<string, IncrementalParser>();
  private knownFiles = new Set<string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sessionsDir: string,
    private events: WatcherEvents,
  ) {}

  start(): void {
    // Scan existing files
    try {
      const files = readdirSync(this.sessionsDir).filter((f) => f.endsWith(".jsonl"));
      for (const file of files) {
        this.knownFiles.add(file);
        const parser = new IncrementalParser();
        this.parsers.set(file, parser);
        // Initialize parser offset by reading current content
        parser.readNew(join(this.sessionsDir, file));
      }
    } catch {
      // sessions dir may not exist yet
    }

    // fs.watch for immediate notifications
    try {
      this.watcher = watch(this.sessionsDir, (_eventType, filename) => {
        if (!filename || !filename.endsWith(".jsonl")) return;
        this.debouncedCheck(filename);
      });
    } catch {
      // Fallback to polling only
    }

    // Polling fallback (2s interval) for missed events
    this.pollInterval = setInterval(() => this.pollAll(), 2000);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private debouncedCheck(filename: string): void {
    const existing = this.debounceTimers.get(filename);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      filename,
      setTimeout(() => {
        this.debounceTimers.delete(filename);
        this.checkFile(filename);
      }, 100),
    );
  }

  private async checkFile(filename: string): Promise<void> {
    const filePath = join(this.sessionsDir, filename);
    const sessionId = filename.replace(".jsonl", "");

    // Detect new files
    if (!this.knownFiles.has(filename)) {
      this.knownFiles.add(filename);
      this.parsers.set(filename, new IncrementalParser());
      this.events.onNewSession(sessionId);
    }

    // Read new entries
    const parser = this.parsers.get(filename);
    if (!parser) return;

    try {
      const newEntries = await parser.readNew(filePath);
      if (newEntries.length > 0) {
        this.events.onNewEntries(sessionId, newEntries);
      }
    } catch {
      // File may have been deleted or is temporarily unavailable
    }
  }

  private async pollAll(): Promise<void> {
    let currentFiles: string[];
    try {
      currentFiles = readdirSync(this.sessionsDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return;
    }

    for (const file of currentFiles) {
      await this.checkFile(file);
    }
  }
}
