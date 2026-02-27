import type { AgentEvent, DiligentPaths, Message, SkillMetadata, UserMessage } from "@diligent/core";
import { agentLoop, SessionManager } from "@diligent/core";
import { version as pkgVersion } from "../../package.json";
import type { AppConfig } from "../config";
import { loadConfig } from "../config";
import { ChatView } from "./components/chat-view";
import { ConfirmDialog, type ConfirmDialogOptions } from "./components/confirm-dialog";
import { InputEditor } from "./components/input-editor";
import { StatusBar } from "./components/status-bar";
import { registerBuiltinCommands } from "./commands/builtin/index";
import { parseCommand } from "./commands/parser";
import { CommandRegistry } from "./commands/registry";
import type { CommandContext } from "./commands/types";
import { Container } from "./framework/container";
import { OverlayStack } from "./framework/overlay";
import { TUIRenderer } from "./framework/renderer";
import { StdinBuffer } from "./framework/stdin-buffer";
import { Terminal } from "./framework/terminal";
import { buildTools } from "./tools";

export interface AppOptions {
  resume?: boolean;
}

export class App {
  private terminal: Terminal;
  private renderer: TUIRenderer;
  private overlayStack: OverlayStack;
  private stdinBuffer: StdinBuffer;
  private root: Container;

  // Components
  private chatView: ChatView;
  private inputEditor: InputEditor;
  private statusBar: StatusBar;

  // Commands & Skills
  private commandRegistry: CommandRegistry;
  private skills: SkillMetadata[];

  // State
  private abortController: AbortController | null = null;
  private isProcessing = false;
  private messages: Message[] = [];
  private sessionManager: SessionManager | null = null;

  constructor(
    private config: AppConfig,
    private paths?: DiligentPaths,
    private options?: AppOptions,
  ) {
    this.terminal = new Terminal();
    this.overlayStack = new OverlayStack();
    this.stdinBuffer = new StdinBuffer();

    // Initialize command registry
    this.skills = config.skills ?? [];
    this.commandRegistry = new CommandRegistry();
    registerBuiltinCommands(this.commandRegistry, this.skills);

    const requestRender = () => this.renderer.requestRender();

    // Build component tree
    this.chatView = new ChatView({ requestRender });
    this.inputEditor = new InputEditor(
      {
        onSubmit: (text) => this.handleSubmit(text),
        onCancel: () => this.handleCancel(),
        onExit: () => this.shutdown(),
        onComplete: (partial) => this.commandRegistry.complete(partial),
        onCompleteDetailed: (partial) => this.commandRegistry.completeDetailed(partial),
      },
      requestRender,
    );
    this.statusBar = new StatusBar();

    this.root = new Container();
    this.root.addChild(this.chatView);
    this.root.addChild(this.inputEditor);
    this.root.addChild(this.statusBar);

    this.renderer = new TUIRenderer(this.terminal, this.root);
    this.renderer.setOverlayStack(this.overlayStack);
  }

  async start(): Promise<void> {
    // Start terminal
    this.terminal.start(
      (data) => this.handleInput(data),
      () => this.renderer.requestRender(),
    );

    // Show welcome banner
    this.chatView.addLines(this.buildWelcomeBanner());

    // Update status bar with model info and cwd
    this.statusBar.update({ model: this.config.model.id, status: "idle", cwd: process.cwd() });

    // Initialize SessionManager
    if (this.paths) {
      const cwd = process.cwd();
      const tools = buildTools(cwd, this.paths);

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

    // Set focus to input and start rendering
    this.renderer.setFocus(this.inputEditor);
    this.renderer.start();
  }

  private handleInput(data: string): void {
    const sequences = this.stdinBuffer.split(data);

    for (const seq of sequences) {
      // Overlay takes all input when visible
      if (this.overlayStack.hasVisible()) {
        const topComponent = this.overlayStack.getTopComponent();
        topComponent?.handleInput?.(seq);
        this.renderer.requestRender();
        continue;
      }

      if (!this.isProcessing) {
        this.inputEditor.handleInput(seq);
      } else if (seq === "\x03") {
        // During processing, only handle ctrl+c
        this.handleCancel();
      }
    }
  }

  private async handleSubmit(text: string): Promise<void> {
    // Check for slash command
    const parsed = parseCommand(text);
    if (parsed) {
      await this.handleCommand(parsed.name, parsed.args);
      return;
    }

    this.isProcessing = true;
    this.abortController = new AbortController();

    this.chatView.addUserMessage(text);
    this.statusBar.update({ status: "busy" });
    this.renderer.requestRender();

    const userMessage: UserMessage = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    this.messages.push(userMessage);

    try {
      if (this.sessionManager) {
        const stream = this.sessionManager.run(userMessage);
        for await (const event of stream) {
          this.handleAgentEvent(event);
        }
        const result = await stream.result();
        this.messages = result;
      } else {
        const cwd = process.cwd();
        const tools = buildTools(cwd, this.paths);
        const loopFn = this.config.agentLoopFn ?? agentLoop;
        const loop = loopFn(this.messages, {
          model: this.config.model,
          systemPrompt: this.config.systemPrompt,
          tools,
          streamFunction: this.config.streamFunction,
          signal: this.abortController.signal,
        });

        for await (const event of loop) {
          this.handleAgentEvent(event);
        }
        const result = await loop.result();
        this.messages = result;
      }
    } catch (err) {
      this.chatView.handleEvent({
        type: "error",
        error: {
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : "Error",
        },
        fatal: false,
      });
    }

    this.isProcessing = false;
    this.abortController = null;
    this.statusBar.update({ status: "idle" });
    this.renderer.requestRender();
  }

  private async handleCommand(name: string, args: string | undefined): Promise<void> {
    const command = this.commandRegistry.get(name);
    if (!command) {
      this.chatView.addLines([`  \x1b[31mUnknown command: /${name}\x1b[0m`, "  Type /help for available commands."]);
      this.renderer.requestRender();
      return;
    }

    if (this.isProcessing && !command.availableDuringTask) {
      this.chatView.addLines(["  \x1b[33mCommand not available while agent is running.\x1b[0m"]);
      this.renderer.requestRender();
      return;
    }

    const ctx = this.buildCommandContext();
    try {
      await command.handler(args, ctx);
    } catch (err) {
      this.chatView.addLines([
        `  \x1b[31mCommand error: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
      ]);
    }
    this.renderer.requestRender();
  }

  private buildCommandContext(): CommandContext {
    return {
      app: { confirm: (o) => this.confirm(o), stop: () => this.shutdown() },
      config: this.config,
      sessionManager: this.sessionManager,
      skills: this.skills,
      registry: this.commandRegistry,
      requestRender: () => this.renderer.requestRender(),
      displayLines: (lines) => {
        this.chatView.addLines(lines);
        this.renderer.requestRender();
      },
      displayError: (msg) => {
        this.chatView.addLines([`  \x1b[31m${msg}\x1b[0m`]);
        this.renderer.requestRender();
      },
      showOverlay: (c, o) => this.overlayStack.show(c, o),
      runAgent: (text) => this.handleSubmit(text),
      reload: () => this.reloadConfig(),
    };
  }

  private async reloadConfig(): Promise<void> {
    try {
      const newConfig = await loadConfig(process.cwd(), this.paths);
      this.config = newConfig;
      this.skills = newConfig.skills ?? [];

      // Rebuild command registry with new skills
      this.commandRegistry = new CommandRegistry();
      registerBuiltinCommands(this.commandRegistry, this.skills);

      this.statusBar.update({ model: newConfig.model.id });
    } catch (err) {
      this.chatView.addLines([
        `  \x1b[31mReload error: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
      ]);
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    this.chatView.handleEvent(event);

    // Update status bar with usage info
    if (event.type === "usage") {
      this.statusBar.update({
        tokensUsed: event.usage.inputTokens + event.usage.outputTokens,
      });
    }
  }

  private handleCancel(): void {
    if (this.isProcessing && this.abortController) {
      this.showConfirm({
        title: "Abort?",
        message: "Cancel the current operation?",
        confirmLabel: "Yes",
        cancelLabel: "No",
      }).then((confirmed) => {
        if (confirmed) {
          this.abortController?.abort();
        }
      });
    } else if (!this.isProcessing) {
      this.shutdown();
    }
  }

  /** Show a confirmation dialog overlay */
  async confirm(options: ConfirmDialogOptions): Promise<boolean> {
    return this.showConfirm(options);
  }

  private showConfirm(options: ConfirmDialogOptions): Promise<boolean> {
    return new Promise((resolve) => {
      const dialog = new ConfirmDialog(options, (confirmed) => {
        handle.hide();
        this.renderer.setFocus(this.inputEditor);
        this.renderer.requestRender();
        resolve(confirmed);
      });
      const handle = this.overlayStack.show(dialog, { anchor: "center" });
      this.renderer.requestRender();
    });
  }

  /** Stop the TUI */
  stop(): void {
    this.overlayStack.clear();
    this.renderer.stop();
    this.terminal.stop();
  }

  private buildWelcomeBanner(): string[] {
    const cwd = process.cwd();
    const home = process.env.HOME ?? "";
    const dir = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;

    const boxWidth = Math.min(54, Math.max(44, this.terminal.columns - 2));
    const inner = boxWidth - 4; // 2 borders + 2 spaces padding

    const pad = (s: string) => s + " ".repeat(Math.max(0, inner - s.length));
    const truncate = (s: string) =>
      s.length > inner ? `${s.slice(0, inner - 1)}\u2026` : s;

    const title = `>_ diligent (v${pkgVersion})`;
    const modelLine = truncate(`model:     ${this.config.model.id}`);
    const dirLine = truncate(`directory: ${dir}`);

    const row = (s: string) => `\x1b[2m\u2502 ${pad(s)} \u2502\x1b[0m`;

    return [
      `\x1b[2m\u256d${"─".repeat(boxWidth - 2)}\u256e\x1b[0m`,
      `\x1b[2m\u2502\x1b[0m \x1b[1m${pad(title)}\x1b[0m \x1b[2m\u2502\x1b[0m`,
      row(""),
      row(modelLine),
      row(dirLine),
      `\x1b[2m\u2570${"─".repeat(boxWidth - 2)}\u256f\x1b[0m`,
      "",
      `\x1b[2m  Tip: /help for commands \u00b7 ctrl+c to cancel \u00b7 ctrl+d to exit\x1b[0m`,
      "",
    ];
  }

  private shutdown(): void {
    this.stop();
    this.terminal.write("\n\x1b[2mGoodbye!\x1b[0m\n");
    process.exit(0);
  }
}
