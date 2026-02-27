import type { AgentEvent, DiligentPaths, Message, UserMessage } from "@diligent/core";
import { agentLoop, SessionManager } from "@diligent/core";
import type { AgentLoopFn, AppConfig } from "../config";
import { buildTools } from "./tools";

export interface RunnerOptions {
  resume?: boolean;
}

export class NonInteractiveRunner {
  private messages: Message[] = [];
  private sessionManager: SessionManager | null = null;
  private exitCode = 0;
  private isThinking = false;

  constructor(
    private config: AppConfig,
    private paths?: DiligentPaths,
    private options?: RunnerOptions,
  ) {}

  async run(prompt: string): Promise<number> {
    const cwd = process.cwd();
    const tools = buildTools(cwd, this.paths);
    const isTTY = process.stderr.isTTY === true;

    // Initialize SessionManager if paths available
    if (this.paths) {
      this.sessionManager = new SessionManager({
        cwd,
        paths: this.paths,
        agentConfig: {
          model: this.config.model,
          systemPrompt: this.config.systemPrompt,
          tools,
          streamFunction: this.config.streamFunction,
        },
        compaction: {
          enabled: this.config.diligent.compaction?.enabled ?? true,
          reserveTokens: this.config.diligent.compaction?.reserveTokens ?? 16384,
          keepRecentTokens: this.config.diligent.compaction?.keepRecentTokens ?? 20000,
        },
        knowledgePath: this.paths.knowledge,
      });

      if (this.options?.resume) {
        const resumed = await this.sessionManager.resume({ mostRecent: true });
        if (resumed) {
          this.messages = this.sessionManager.getContext();
        }
      } else {
        await this.sessionManager.create();
      }
    }

    const userMessage: UserMessage = {
      role: "user",
      content: prompt,
      timestamp: Date.now(),
    };
    this.messages.push(userMessage);

    let hasText = false;

    try {
      if (this.sessionManager) {
        const stream = this.sessionManager.run(userMessage);
        for await (const event of stream) {
          hasText = this.handleEvent(event, isTTY, hasText);
        }
        await stream.result();
      } else {
        const loopFn: AgentLoopFn = this.config.agentLoopFn ?? agentLoop;
        const loop = loopFn(this.messages, {
          model: this.config.model,
          systemPrompt: this.config.systemPrompt,
          tools,
          streamFunction: this.config.streamFunction,
        });

        for await (const event of loop) {
          hasText = this.handleEvent(event, isTTY, hasText);
        }
        await loop.result();
      }
    } catch (err) {
      this.writeStderr(`[error] ${err instanceof Error ? err.message : String(err)}`, isTTY);
      this.exitCode = 1;
    }

    if (hasText) {
      process.stdout.write("\n");
    }

    return this.exitCode;
  }

  private handleEvent(event: AgentEvent, isTTY: boolean, hasText: boolean): boolean {
    switch (event.type) {
      case "message_delta":
        if (event.delta.type === "thinking_delta") {
          if (!this.isThinking) {
            this.isThinking = true;
            this.writeStderr("[thinking] Reasoning...", isTTY);
          }
          return hasText;
        }
        if (event.delta.type === "text_delta") {
          this.isThinking = false;
          process.stdout.write(event.delta.delta);
          return true;
        }
        return hasText;

      case "message_end":
        this.isThinking = false;
        return hasText;

      case "tool_start":
        this.writeStderr(`[tool:${event.toolName}] Running...`, isTTY);
        return hasText;

      case "tool_end": {
        const lines = event.output ? event.output.split("\n").length : 0;
        this.writeStderr(`[tool:${event.toolName}] Done (${lines} lines)`, isTTY);
        return hasText;
      }

      case "usage": {
        const costStr = event.cost > 0 ? ` ($${event.cost.toFixed(4)})` : "";
        this.writeStderr(`[usage] ${event.usage.inputTokens}in/${event.usage.outputTokens}out${costStr}`, isTTY);
        return hasText;
      }

      case "compaction_start":
        this.writeStderr(`[compaction] Compacting (${Math.round(event.estimatedTokens / 1000)}k tokens)...`, isTTY);
        return hasText;

      case "compaction_end":
        this.writeStderr(
          `[compaction] ${Math.round(event.tokensBefore / 1000)}k -> ${Math.round(event.tokensAfter / 1000)}k tokens`,
          isTTY,
        );
        return hasText;

      case "knowledge_saved":
        this.writeStderr(`[knowledge] ${event.content}`, isTTY);
        return hasText;

      case "error":
        this.writeStderr(`[error] ${event.error.message}`, isTTY);
        if (event.fatal) {
          this.exitCode = 1;
        }
        return hasText;

      default:
        return hasText;
    }
  }

  private writeStderr(msg: string, isTTY: boolean): void {
    if (isTTY) {
      process.stderr.write(`\x1b[2m${msg}\x1b[0m\n`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
  }
}
