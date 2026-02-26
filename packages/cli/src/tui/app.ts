import type { AgentEvent, DiligentPaths, Message, UserMessage } from "@diligent/core";
import { agentLoop, SessionManager } from "@diligent/core";
import { version as pkgVersion } from "../../package.json";
import type { AppConfig } from "../config";
import { ChatView } from "./components/chat-view";
import { ConfirmDialog, type ConfirmDialogOptions } from "./components/confirm-dialog";
import { InputEditor } from "./components/input-editor";
import { StatusBar } from "./components/status-bar";
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

    const requestRender = () => this.renderer.requestRender();

    // Build component tree
    this.chatView = new ChatView({ requestRender });
    this.inputEditor = new InputEditor(
      {
        prompt: "diligent> ",
        onSubmit: (text) => this.handleSubmit(text),
        onCancel: () => this.handleCancel(),
        onExit: () => this.shutdown(),
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

    // Show welcome banner in chatView
    this.chatView.addUserMessage(`\x1b[1;36mdiligent\x1b[0m \x1b[2mv${pkgVersion}\x1b[0m`);

    // Update status bar with model info
    this.statusBar.update({ model: this.config.model.id, status: "idle" });

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
      // Route input based on overlay state
      if (this.overlayStack.hasVisible()) {
        const topComponent = this.overlayStack.getTopComponent();
        topComponent?.handleInput?.(seq);
        this.renderer.requestRender();
      } else if (!this.isProcessing) {
        this.inputEditor.handleInput(seq);
      } else {
        // During processing, only handle ctrl+c
        if (seq === "\x03") {
          this.handleCancel();
        }
      }
    }
  }

  private async handleSubmit(text: string): Promise<void> {
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

  private shutdown(): void {
    this.stop();
    this.terminal.write("\n\x1b[2mGoodbye!\x1b[0m\n");
    process.exit(0);
  }
}
