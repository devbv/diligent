import type { AgentEvent } from "@diligent/core";
import type { Component } from "../framework/types";
import { MarkdownView } from "./markdown-view";
import { SpinnerComponent } from "./spinner";

export interface ChatViewOptions {
  requestRender: () => void;
}

/**
 * Main conversation view — message list, streaming output, tool execution display.
 * Composes MarkdownView and SpinnerComponent internally.
 */
export class ChatView implements Component {
  private lines: string[] = [];
  private activeMarkdown: MarkdownView | null = null;
  private activeSpinner: SpinnerComponent;
  private lastUsage: { input: number; output: number; cost: number } | null = null;

  constructor(private options: ChatViewOptions) {
    this.activeSpinner = new SpinnerComponent(options.requestRender);
  }

  /** Handle agent events to update the view */
  handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "message_start":
        this.activeMarkdown = new MarkdownView(this.options.requestRender);
        break;

      case "message_delta":
        if (event.delta.type === "text_delta" && this.activeMarkdown) {
          this.activeMarkdown.pushDelta(event.delta.delta);
        }
        break;

      case "message_end":
        if (this.activeMarkdown) {
          this.activeMarkdown.finalize();
          // Commit rendered lines to history
          this.lines.push(...this.activeMarkdown.render(80));
          this.activeMarkdown = null;
        }
        break;

      case "tool_start":
        this.activeSpinner.start(`Running ${event.toolName}...`);
        break;

      case "tool_update":
        this.activeSpinner.setMessage(`Running ${event.toolName}... (partial output)`);
        break;

      case "tool_end":
        this.activeSpinner.stop();
        if (event.output) {
          const outputLines = event.output.split("\n");
          const display =
            outputLines.length > 20
              ? [...outputLines.slice(0, 20), `\x1b[2m... (${outputLines.length - 20} more lines)\x1b[0m`]
              : outputLines;
          this.lines.push(`\x1b[2m[${event.toolName}]\x1b[0m`);
          for (const line of display) {
            this.lines.push(`\x1b[2m  ${line}\x1b[0m`);
          }
        }
        this.options.requestRender();
        break;

      case "status_change":
        if (event.status === "retry" && event.retry) {
          this.activeSpinner.start(
            `Retrying (attempt ${event.retry.attempt}, waiting ${Math.round(event.retry.delayMs / 1000)}s)...`,
          );
        }
        break;

      case "usage":
        this.lastUsage = {
          input: event.usage.inputTokens,
          output: event.usage.outputTokens,
          cost: event.cost,
        };
        {
          const costStr = event.cost > 0 ? ` ($${event.cost.toFixed(4)})` : "";
          this.lines.push(
            `\x1b[2m[tokens: ${event.usage.inputTokens}in/${event.usage.outputTokens}out${costStr}]\x1b[0m`,
          );
        }
        this.options.requestRender();
        break;

      case "compaction_start":
        this.activeSpinner.start(`Compacting context (${Math.round(event.estimatedTokens / 1000)}k tokens)...`);
        break;

      case "compaction_end":
        this.activeSpinner.stop();
        this.lines.push(
          `\x1b[2mContext compacted: ${Math.round(event.tokensBefore / 1000)}k -> ${Math.round(event.tokensAfter / 1000)}k tokens\x1b[0m`,
        );
        this.options.requestRender();
        break;

      case "knowledge_saved":
        this.lines.push(`\x1b[2m[knowledge] ${event.content}\x1b[0m`);
        this.options.requestRender();
        break;

      case "error":
        this.activeSpinner.stop();
        this.lines.push(`\x1b[31mError: ${event.error.message}\x1b[0m`);
        this.options.requestRender();
        break;

      default:
        break;
    }
  }

  /** Add a user message to the display */
  addUserMessage(text: string): void {
    this.lines.push("");
    this.lines.push(`\x1b[1;36mdiligent>\x1b[0m ${text}`);
    this.lines.push("");
    this.options.requestRender();
  }

  /** Get last usage info (for StatusBar) */
  getLastUsage(): { input: number; output: number; cost: number } | null {
    return this.lastUsage;
  }

  render(width: number): string[] {
    const result = [...this.lines];

    // Add active streaming markdown
    if (this.activeMarkdown) {
      result.push(...this.activeMarkdown.render(width));
    }

    // Add active spinner
    if (this.activeSpinner.isRunning) {
      result.push(...this.activeSpinner.render(width));
    }

    return result;
  }

  invalidate(): void {
    this.activeMarkdown?.invalidate();
    this.activeSpinner.invalidate();
  }
}
