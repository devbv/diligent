import { Terminal } from "./terminal";
import { InputBuffer, Keys, matchesKey } from "./input";
import { renderMarkdown } from "./markdown";
import { Spinner } from "./spinner";
import { agentLoop } from "@diligent/core";
import type { AgentEvent } from "@diligent/core";
import type { UserMessage, Message } from "@diligent/core";
import type { AppConfig } from "../config";
import {
  bashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createLsTool,
  createGlobTool,
  createGrepTool,
  createAnthropicStream,
} from "@diligent/core";

// @ts-ignore — Bun resolves workspace package.json at runtime
import { version as pkgVersion } from "../../package.json";

export class App {
  private terminal = new Terminal();
  private input = new InputBuffer();
  private abortController: AbortController | null = null;
  private isProcessing = false;
  private messages: Message[] = [];
  private accumulatedText = "";
  private spinner: Spinner;
  private lastRenderedLength = 0;

  constructor(private config: AppConfig) {
    this.spinner = new Spinner((frame) => this.renderSpinner(frame));
  }

  async start(): Promise<void> {
    this.terminal.start(
      (data) => this.handleInput(data),
      () => {}, // resize — no-op for now
    );
    this.terminal.write(
      `\x1b[1;36mdiligent\x1b[0m \x1b[2mv${pkgVersion}\x1b[0m\n` +
      "\x1b[2mType a message to start. Ctrl+C to abort, Ctrl+D to exit.\x1b[0m\n",
    );
    this.showPrompt();
  }

  private showPrompt(): void {
    this.terminal.write("\n\x1b[1;36mdiligent>\x1b[0m ");
  }

  private handleInput(data: Buffer): void {
    if (matchesKey(data, Keys.CTRL_C)) {
      if (this.isProcessing && this.abortController) {
        this.abortController.abort();
        this.terminal.write("\n\x1b[33m[Aborted]\x1b[0m");
      } else {
        this.shutdown();
      }
      return;
    }

    if (matchesKey(data, Keys.CTRL_D)) {
      this.shutdown();
      return;
    }

    if (this.isProcessing) return;

    if (matchesKey(data, Keys.ENTER)) {
      const text = this.input.clear().trim();
      if (text) {
        this.terminal.write("\n");
        this.processMessage(text);
      }
      return;
    }

    if (matchesKey(data, Keys.BACKSPACE)) {
      this.input.backspace();
      this.redrawInput();
      return;
    }

    if (matchesKey(data, Keys.LEFT)) {
      this.input.moveLeft();
      this.redrawInput();
      return;
    }

    if (matchesKey(data, Keys.RIGHT)) {
      this.input.moveRight();
      this.redrawInput();
      return;
    }

    // Printable character
    const str = data.toString("utf-8");
    if (str.length === 1 && str.charCodeAt(0) >= 32) {
      this.input.insert(str);
      this.redrawInput();
    }
  }

  private redrawInput(): void {
    this.terminal.clearLine();
    this.terminal.write(`\x1b[1;36mdiligent>\x1b[0m ${this.input.text}`);
    // Move cursor to correct position
    const diff = this.input.text.length - this.input.cursorPos;
    if (diff > 0) {
      this.terminal.write(`\x1b[${diff}D`);
    }
  }

  private renderSpinner(frame: string): void {
    this.terminal.clearLine();
    this.terminal.write(frame);
  }

  private async processMessage(text: string): Promise<void> {
    this.isProcessing = true;
    this.abortController = new AbortController();
    this.accumulatedText = "";
    this.lastRenderedLength = 0;

    const userMessage: UserMessage = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    this.messages.push(userMessage);

    const cwd = process.cwd();
    const tools = [
      bashTool,
      createReadTool(),
      createWriteTool(),
      createEditTool(),
      createLsTool(),
      createGlobTool(cwd),
      createGrepTool(cwd),
    ];

    const loop = agentLoop(this.messages, {
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      tools,
      streamFunction: createAnthropicStream,
      apiKey: this.config.apiKey,
      signal: this.abortController.signal,
    });

    try {
      for await (const event of loop) {
        this.handleAgentEvent(event);
      }

      const result = await loop.result();
      this.messages = result;
    } catch (err) {
      this.terminal.write(
        `\n\x1b[31mError: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
      );
    }

    this.spinner.stop();
    this.isProcessing = false;
    this.abortController = null;
    this.showPrompt();
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "message_start":
        this.accumulatedText = "";
        this.lastRenderedLength = 0;
        break;

      case "message_delta":
        if (event.delta.type === "text_delta") {
          this.accumulatedText += event.delta.delta;
          // Render markdown incrementally
          const rendered = renderMarkdown(this.accumulatedText, this.terminal.columns);
          // Simple approach: write the new delta directly for streaming feel
          // On message_end, do a full re-render
          this.terminal.write(event.delta.delta);
        }
        break;

      case "message_end": {
        // Final markdown render — clear and re-render the full message
        // Move cursor to start of message area and rewrite
        if (this.accumulatedText) {
          // Erase the raw text by moving up and clearing
          const rawLines = this.accumulatedText.split("\n").length;
          // Move up rawLines and clear
          for (let i = 0; i < rawLines; i++) {
            this.terminal.write("\x1b[2K"); // clear current line
            if (i < rawLines - 1) this.terminal.write("\x1b[A"); // move up
          }
          this.terminal.write("\r"); // move to beginning
          // Write final markdown-rendered text
          const rendered = renderMarkdown(this.accumulatedText, this.terminal.columns);
          this.terminal.write(rendered);
          this.terminal.write("\n");
        }
        this.accumulatedText = "";
        break;
      }

      case "tool_start":
        this.spinner.start(`Running ${event.toolName}...`);
        break;

      case "tool_update":
        this.spinner.setMessage(`Running ${event.toolName}... (partial output)`);
        break;

      case "tool_end":
        this.spinner.stop();
        this.terminal.clearLine();
        // Show tool result summary
        if (event.output) {
          const lines = event.output.split("\n");
          const display = lines.length > 20
            ? [...lines.slice(0, 20), `\x1b[2m... (${lines.length - 20} more lines)\x1b[0m`].join("\n")
            : event.output;
          this.terminal.write(`\x1b[2m[${event.toolName}] ${display}\x1b[0m\n`);
        }
        break;

      case "status_change":
        if (event.status === "retry" && event.retry) {
          this.spinner.start(`Retrying (attempt ${event.retry.attempt}, waiting ${Math.round(event.retry.delayMs / 1000)}s)...`);
        }
        break;

      case "usage": {
        // Show token/cost info (subtle gray text)
        const costStr = event.cost > 0
          ? ` ($${event.cost.toFixed(4)})`
          : "";
        this.terminal.write(
          `\x1b[2m[tokens: ${event.usage.inputTokens}in/${event.usage.outputTokens}out${costStr}]\x1b[0m\n`,
        );
        break;
      }

      case "error":
        this.spinner.stop();
        this.terminal.write(
          `\n\x1b[31mError: ${event.error.message}\x1b[0m\n`,
        );
        break;

      default:
        break;
    }
  }

  private shutdown(): void {
    this.spinner.stop();
    this.terminal.write("\n\x1b[2mGoodbye!\x1b[0m\n");
    this.terminal.stop();
    process.exit(0);
  }
}
