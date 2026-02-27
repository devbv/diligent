import type { AgentEvent } from "@diligent/core";
import { debugLogger } from "../framework/debug-logger";
import type { Component } from "../framework/types";
import { t } from "../theme";
import { MarkdownView } from "./markdown-view";
import { SpinnerComponent } from "./spinner";

function formatTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function formatToolElapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}m ${(s % 60).toString().padStart(2, "0")}s`;
}

/** Middle-truncate lines to at most `max`, inserting `… +N lines` in the middle */
function truncateMiddle(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  const head = Math.floor((max - 1) / 2);
  const tail = max - head - 1;
  const omitted = lines.length - head - tail;
  return [
    ...lines.slice(0, head),
    `… +${omitted} lines`,
    ...lines.slice(lines.length - tail),
  ];
}

/** User message rendered with a subtle background color (width-aware) */
class UserMessageView {
  constructor(private text: string) {}

  render(width: number): string[] {
    const visibleLen = 3 + this.text.length; // " › " = 3 visible chars
    const padding = " ".repeat(Math.max(0, width - visibleLen));
    return [`${t.bgUser} ${t.bold}${t.dim}›${t.reset}${t.bgUser} ${this.text}${padding}${t.reset}`];
  }

  invalidate(): void {}
}

export interface ChatViewOptions {
  requestRender: () => void;
}

/** A committed item in the chat history */
type ChatItem = string[] | MarkdownView | UserMessageView;

const TOOL_MAX_LINES = 5;

/**
 * Main conversation view — message list, streaming output, tool execution display.
 * Composes MarkdownView and SpinnerComponent internally.
 */
export class ChatView implements Component {
  private items: ChatItem[] = [];
  private activeMarkdown: MarkdownView | null = null;
  private activeSpinner: SpinnerComponent;
  private thinkingSpinner: SpinnerComponent;
  private thinkingStartTime: number | null = null;
  private thinkingText = "";
  private lastUsage: { input: number; output: number; cost: number } | null = null;
  private toolStartTimes = new Map<string, number>();

  constructor(private options: ChatViewOptions) {
    this.activeSpinner = new SpinnerComponent(options.requestRender);
    this.thinkingSpinner = new SpinnerComponent(options.requestRender);
  }

  /** Handle agent events to update the view */
  handleEvent(event: AgentEvent): void {
    debugLogger.logAgentEvent(event);
    switch (event.type) {
      case "message_start":
        this.activeMarkdown = new MarkdownView(this.options.requestRender);
        break;

      case "message_delta":
        if (event.delta.type === "thinking_delta") {
          this.thinkingText += event.delta.delta;
          if (!this.thinkingSpinner.isRunning) {
            this.thinkingStartTime = Date.now();
            this.thinkingSpinner.start("Thinking\u2026");
          }
        } else if (event.delta.type === "text_delta" && this.activeMarkdown) {
          if (this.thinkingSpinner.isRunning) {
            this.commitThinkingBlock();
          }
          this.activeMarkdown.pushDelta(event.delta.delta);
        }
        break;

      case "message_end":
        if (this.thinkingSpinner.isRunning) {
          this.commitThinkingBlock();
        }
        if (this.activeMarkdown) {
          this.activeMarkdown.finalize();
          this.items.push(this.activeMarkdown);
          this.activeMarkdown = null;
        }
        break;

      case "tool_start":
        this.toolStartTimes.set(event.toolCallId, Date.now());
        this.activeSpinner.start(event.toolName);
        break;

      case "tool_update":
        this.activeSpinner.setMessage(`${event.toolName}…`);
        break;

      case "tool_end": {
        this.activeSpinner.stop();
        const startTime = this.toolStartTimes.get(event.toolCallId);
        this.toolStartTimes.delete(event.toolCallId);
        const elapsed = startTime !== undefined ? ` ${t.dim}· ${formatToolElapsed(Date.now() - startTime)}${t.reset}` : "";

        if (event.output) {
          const rawLines = event.output.split("\n");
          const display = truncateMiddle(rawLines, TOOL_MAX_LINES);
          const lines: string[] = [`${t.success}⏺${t.reset} ${event.toolName}${elapsed}`];
          for (let i = 0; i < display.length; i++) {
            const isEllipsis = display[i].startsWith("… +");
            if (isEllipsis) {
              lines.push(`${t.dim}    ${display[i]}${t.reset}`);
            } else if (i === 0) {
              lines.push(`${t.dim}  └ ${display[i]}${t.reset}`);
            } else {
              lines.push(`${t.dim}    ${display[i]}${t.reset}`);
            }
          }
          this.items.push(lines);
        } else {
          this.items.push([`${t.success}⏺${t.reset} ${event.toolName}${elapsed}`]);
        }
        this.options.requestRender();
        break;
      }

      case "status_change":
        if (event.status === "retry" && event.retry) {
          this.activeSpinner.start(
            `Retrying (attempt ${event.retry.attempt}, waiting ${Math.round(event.retry.delayMs / 1000)}s)…`,
          );
        }
        break;

      case "usage":
        // Track for StatusBar — not displayed in chat
        this.lastUsage = {
          input: event.usage.inputTokens,
          output: event.usage.outputTokens,
          cost: event.cost,
        };
        break;

      case "compaction_start":
        this.activeSpinner.start(`Compacting context (${formatTokensCompact(event.estimatedTokens)} tokens)…`);
        break;

      case "compaction_end":
        this.activeSpinner.stop();
        this.items.push([
          `${t.success}⏺${t.reset} ${t.dim}compacted: ${formatTokensCompact(event.tokensBefore)} → ${formatTokensCompact(event.tokensAfter)}${t.reset}`,
        ]);
        this.options.requestRender();
        break;

      case "knowledge_saved":
        this.items.push([`${t.success}⏺${t.reset} ${t.dim}knowledge saved${t.reset}`]);
        this.options.requestRender();
        break;

      case "error":
        this.activeSpinner.stop();
        this.thinkingSpinner.stop();
        this.thinkingStartTime = null;
        this.thinkingText = "";
        this.items.push([`${t.error}✗ ${event.error.message}${t.reset}`]);
        this.options.requestRender();
        break;

      default:
        break;
    }
  }

  /** Add a user message to the display */
  addUserMessage(text: string): void {
    this.items.push(new UserMessageView(text));
    this.options.requestRender();
  }

  /** Add raw lines to the display (used for banners, tips, etc.) */
  addLines(lines: string[]): void {
    this.items.push(lines);
    this.options.requestRender();
  }

  /** Commit accumulated thinking block as a collapsed indicator */
  private commitThinkingBlock(): void {
    this.thinkingSpinner.stop();
    if (this.thinkingText.length > 0) {
      const elapsed =
        this.thinkingStartTime !== null ? formatToolElapsed(Date.now() - this.thinkingStartTime) : "";
      const elapsedStr = elapsed ? ` ${t.dim}\xb7 ${elapsed}${t.reset}` : "";
      this.items.push([`${t.dim}\u25b8 Thinking${elapsedStr}${t.reset}`]);
    }
    this.thinkingStartTime = null;
    this.thinkingText = "";
    this.options.requestRender();
  }

  /** Get last usage info (for StatusBar) */
  getLastUsage(): { input: number; output: number; cost: number } | null {
    return this.lastUsage;
  }

  getCommittedLineCount(width: number): number {
    let count = 0;
    for (let i = 0; i < this.items.length; i++) {
      if (i > 0 && count > 0) count++; // blank line between items
      const item = this.items[i];
      if (Array.isArray(item)) {
        count += item.length;
      } else {
        count += item.render(width).length;
      }
    }
    return count;
  }

  render(width: number): string[] {
    const result: string[] = [];
    const TURN_MARKER = `${t.dim}⏺${t.reset} `;

    for (let i = 0; i < this.items.length; i++) {
      if (i > 0 && result.length > 0) result.push("");
      const item = this.items[i];
      if (item instanceof MarkdownView) {
        const lines = item.render(width);
        if (lines.length > 0) {
          result.push(TURN_MARKER + lines[0], ...lines.slice(1));
        }
      } else if (Array.isArray(item)) {
        result.push(...item);
      } else {
        result.push(...item.render(width));
      }
    }

    // Add active thinking spinner
    if (this.thinkingSpinner.isRunning) {
      if (result.length > 0) result.push("");
      result.push(...this.thinkingSpinner.render(width));
    }

    // Add active streaming markdown
    if (this.activeMarkdown) {
      const lines = this.activeMarkdown.render(width);
      if (lines.length > 0) {
        if (result.length > 0) result.push("");
        result.push(TURN_MARKER + lines[0], ...lines.slice(1));
      }
    }

    // Add active spinner
    if (this.activeSpinner.isRunning) {
      if (result.length > 0) result.push("");
      result.push(...this.activeSpinner.render(width));
    }

    return result;
  }

  invalidate(): void {
    for (const item of this.items) {
      if (!Array.isArray(item)) {
        item.invalidate();
      }
    }
    this.activeMarkdown?.invalidate();
    this.thinkingSpinner.invalidate();
    this.activeSpinner.invalidate();
  }
}
