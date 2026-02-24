import { Terminal } from "./terminal";
import { InputBuffer, Keys, matchesKey } from "./input";
import { agentLoop } from "@diligent/core";
import type { AgentEvent } from "@diligent/core";
import type { UserMessage, Message } from "@diligent/core";
import type { AppConfig } from "../config";
import { bashTool } from "@diligent/core";
import { createAnthropicStream } from "@diligent/core";

export class App {
  private terminal = new Terminal();
  private input = new InputBuffer();
  private abortController: AbortController | null = null;
  private isProcessing = false;
  private messages: Message[] = [];

  constructor(private config: AppConfig) {}

  async start(): Promise<void> {
    this.terminal.start(
      (data) => this.handleInput(data),
      () => {}, // resize — no-op in Phase 1
    );
    this.terminal.write(
      "\x1b[1;36mdiligent\x1b[0m \x1b[2mv0.0.1\x1b[0m\n" +
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

  private async processMessage(text: string): Promise<void> {
    this.isProcessing = true;
    this.abortController = new AbortController();

    const userMessage: UserMessage = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    this.messages.push(userMessage);

    const loop = agentLoop(this.messages, {
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      tools: [bashTool],
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

    this.isProcessing = false;
    this.abortController = null;
    this.showPrompt();
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "message_delta":
        if (event.event.type === "text_delta") {
          this.terminal.write(event.event.delta);
        }
        break;

      case "tool_start": {
        const input = event.input as Record<string, unknown>;
        const cmd = input?.command ?? JSON.stringify(input);
        this.terminal.write(
          `\n\x1b[2m[tool: ${event.toolName}] ${cmd}\x1b[0m\n`,
        );
        break;
      }

      case "tool_end":
        // Show truncated tool output
        if (event.output) {
          const lines = event.output.split("\n");
          const display = lines.length > 20
            ? [...lines.slice(0, 20), `\x1b[2m... (${lines.length - 20} more lines)\x1b[0m`].join("\n")
            : event.output;
          this.terminal.write(`\x1b[2m${display}\x1b[0m\n`);
        }
        break;

      case "error":
        this.terminal.write(
          `\n\x1b[31mError: ${event.error.message}\x1b[0m`,
        );
        break;

      default:
        break;
    }
  }

  private shutdown(): void {
    this.terminal.write("\n\x1b[2mGoodbye!\x1b[0m\n");
    this.terminal.stop();
    process.exit(0);
  }
}
