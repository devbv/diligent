// @summary Main TUI application component managing the agent loop and interface

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentEvent,
  DiligentServerNotification,
  DiligentServerRequest,
  DiligentServerRequestResponse,
  Mode as ProtocolMode,
  RequestId,
} from "@diligent/protocol";
import { DILIGENT_CLIENT_REQUEST_METHODS, DILIGENT_SERVER_NOTIFICATION_METHODS } from "@diligent/protocol";
import type { DiligentPaths, SkillMetadata } from "@diligent/runtime";
import { version as pkgVersion } from "../../package.json";
import type { AppConfig } from "../config";
import { AppDialogs } from "./app-dialogs";
import { AppEventController } from "./app-event-controller";
import { buildShutdownMessage, buildTurnTimingLine, buildWelcomeBanner } from "./app-presenter";
import { AppRuntimeState } from "./app-runtime-state";
import { AppSessionLifecycle } from "./app-session-lifecycle";
import { type CommandHandler, createCommandHandler } from "./command-handler";
import { registerBuiltinCommands } from "./commands/builtin/index";
import { CommandRegistry } from "./commands/registry";
import { BottomPane } from "./components/bottom-pane";
import { ChatView } from "./components/chat-view";
import type { ConfirmDialogOptions } from "./components/confirm-dialog";
import { InputEditor } from "./components/input-editor";
import { StatusBar } from "./components/status-bar";
import { type ConfigManager, createConfigManager } from "./config-manager";
import { Container } from "./framework/container";
import { matchesKey } from "./framework/keys";
import { TUIRenderer } from "./framework/renderer";
import { StdinBuffer } from "./framework/stdin-buffer";
import { Terminal, type TerminalOptions } from "./framework/terminal";
import { InputHistory } from "./input-history";
import type { SpawnedAppServer } from "./rpc-client";
import { type SpawnRpcClientOptions, spawnCliAppServer } from "./rpc-framed-client";
import { createSetupWizard, type SetupWizard } from "./setup-wizard";
import { t } from "./theme";
import { createThreadManager, type ThreadManager } from "./thread-manager";
import { createTuiViewModel, type TuiViewModel } from "./view-model";

export interface AppOptions {
  resume?: boolean;
  resumeId?: string;
  rpcClientFactory?: (options: SpawnRpcClientOptions) => Promise<SpawnedAppServer>;
  terminalOptions?: TerminalOptions;
}

export class App {
  private static readonly DEFAULT_STREAM_RENDER_BATCH_MS = 16;
  private terminal: Terminal;
  private renderer: TUIRenderer;
  private stdinBuffer: StdinBuffer;
  private root: Container;

  // Components
  private chatView: ChatView;
  private inputEditor: InputEditor;
  private statusBar: StatusBar;
  private bottomPane: BottomPane;

  // Commands & Skills
  private commandRegistry: CommandRegistry;
  private skills: SkillMetadata[];

  // History
  private inputHistory: InputHistory;

  // State
  private rpcClient: SpawnedAppServer | null = null;
  private runtime: AppRuntimeState;
  private shouldBellOnComplete: boolean;
  private viewModel: TuiViewModel;
  private dialogs: AppDialogs;
  private eventController: AppEventController;
  private sessionLifecycle: AppSessionLifecycle;

  // Extracted modules
  private threadManager: ThreadManager;
  private configManager: ConfigManager;
  private commandHandler: CommandHandler;
  private setupWizard: SetupWizard;
  private streamRenderTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly streamRenderBatchMs: number;
  private pendingUserMessageAcks: string[] = [];
  private suppressNextSteeringInjectedCommit = false;
  private pendingAbortRestartMessage: string | null = null;
  private appServerLogDirInitialized = false;
  private pendingAppServerLogLines: string[] = [];
  private currentAppServerLogSessionId: string | null = null;

  constructor(
    private config: AppConfig,
    private paths?: DiligentPaths,
    private options?: AppOptions,
  ) {
    this.runtime = new AppRuntimeState(config.mode, config.diligent.effort ?? "medium");
    this.streamRenderBatchMs = App.resolveStreamRenderBatchMs();
    this.shouldBellOnComplete = config.diligent.terminalBell !== false;
    this.terminal = new Terminal(this.options?.terminalOptions);
    this.stdinBuffer = new StdinBuffer();

    // Initialize command registry
    this.skills = config.skills ?? [];
    this.commandRegistry = new CommandRegistry();
    registerBuiltinCommands(this.commandRegistry, this.skills);

    const requestRender = () => this.renderer.requestRender();
    const requestRenderBatched = () => {
      if (this.streamRenderTimer) return;
      this.streamRenderTimer = setTimeout(() => {
        this.streamRenderTimer = null;
        this.renderer.requestRender();
      }, this.streamRenderBatchMs);
    };

    // Input history (loaded async in start())
    const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
    this.inputHistory = new InputHistory(join(home, ".diligent", "history"));

    // Build component tree
    this.chatView = new ChatView({
      requestRender,
      requestRenderBatched,
      cwd: process.cwd(),
      getCommitWidth: () => this.terminal.columns,
      loadChildThread: (threadId) => this.threadManager.readThreadById(threadId),
    });
    this.inputEditor = new InputEditor(
      {
        onSubmit: (text) => {
          if (this.runtime.isProcessing) {
            this.commandHandler.handleSteering(text);
          } else {
            this.commandHandler.handleSubmit(text);
          }
        },
        onCancel: () => this.handleCancel(),
        onExit: () => this.shutdown(),
        onComplete: (partial) => this.commandRegistry.complete(partial),
        onCompleteDetailed: (partial) => this.commandRegistry.completeDetailed(partial),
        history: this.inputHistory,
      },
      requestRender,
    );
    this.statusBar = new StatusBar();
    this.bottomPane = new BottomPane(this.chatView.getLiveStackComponent(), this.inputEditor, this.statusBar);

    this.root = new Container();
    this.root.addChild(this.chatView.getHistoryComponent());
    this.root.addChild(this.bottomPane);

    this.renderer = new TUIRenderer(this.terminal, this.root);
    this.viewModel = createTuiViewModel({
      chatView: this.chatView,
      inputEditor: this.inputEditor,
      statusBar: this.statusBar,
      getThreadId: () => this.runtime.currentThreadId,
      getIsProcessing: () => this.runtime.isProcessing,
      getMode: () => this.runtime.currentMode,
      getEffort: () => this.runtime.currentEffort,
    });
    this.dialogs = new AppDialogs({
      renderer: this.renderer,
      runtime: this.runtime,
      setActiveInlineQuestion: (component) => this.chatView.setActiveQuestion(component),
      restoreFocus: () => this.renderer.setFocus(this.inputEditor),
    });
    this.eventController = new AppEventController({
      runtime: this.runtime,
      handleAgentEvent: (event) => this.handleAgentEvent(event),
      onTurnFinished: () => {
        this.chatView.finishTurn();
        this.appendLocalTurnTimingLine();
        const restartingAfterInterrupt = this.pendingAbortRestartMessage !== null;
        if (!restartingAfterInterrupt) {
          this.ringTerminalBell();
        }
        const pendingTurn = this.runtime.pendingTurn;
        this.runtime.pendingTurn = null;
        if (!restartingAfterInterrupt) {
          this.runtime.isProcessing = false;
          this.inputEditor.setBusy(false);
          this.statusBar.update({ status: "idle" });
        }
        this.runtime.cancelRequested = false;
        pendingTurn?.resolve();
        this.renderer.requestRender();
      },
      onTurnErrored: (message) => {
        this.suppressNextSteeringInjectedCommit = false;
        this.pendingAbortRestartMessage = null;
        this.runtime.isProcessing = false;
        this.runtime.cancelRequested = false;
        const pendingTurn = this.runtime.pendingTurn;
        this.runtime.pendingTurn = null;
        this.inputEditor.setBusy(false);
        this.statusBar.update({ status: "idle" });
        this.renderer.requestRender();
        pendingTurn?.reject(new Error(message));
      },
      onUserInputRequestResolved: () => {
        this.runtime.activeQuestionCancel?.();
      },
      onAccountLoginCompleted: (result) => {
        this.runtime.pendingOAuthResolve?.(result);
        this.runtime.pendingOAuthResolve = null;
      },
      onMcpLoginCompleted: ({ server, success, toolCount, error }) => {
        const resolve = this.runtime.pendingMcpLoginResolve.get(server);
        this.runtime.pendingMcpLoginResolve.delete(server);
        resolve?.({ success, toolCount, error });
      },
      requestApproval: (request) => this.dialogs.handleApprove(request),
      requestUserInput: (request) => this.dialogs.handleAsk(request),
    });

    this.threadManager = createThreadManager({
      getRpcClient: () => this.rpcClient,
      getCurrentMode: () => this.runtime.currentMode,
      getModelId: () => this.config.model.id,
      setCurrentThreadId: (id) => {
        this.runtime.currentThreadId = id;
        this.updateAppServerLogSession(id);
      },
      updateStatusBar: (updates) => this.statusBar.update(updates),
    });

    this.configManager = createConfigManager({
      getRpcClient: () => this.rpcClient,
      getCurrentThreadId: () => this.runtime.currentThreadId,
      getConfig: () => this.config,
      setConfig: (c) => {
        this.config = c;
      },
      getPaths: () => this.paths,
      setCurrentMode: (mode) => {
        this.runtime.currentMode = mode;
      },
      setCurrentEffort: (effort) => {
        this.runtime.currentEffort = effort;
      },
      restartRpcClient: async () => {
        await this.restartRpcClient();
      },
      setSkills: (s) => {
        this.skills = s;
      },
      setCommandRegistry: (r) => {
        this.commandRegistry = r;
      },
      updateStatusBar: (updates) => this.statusBar.update(updates),
      displayError: (msg) => {
        this.chatView.addLines([`  ${t.error}${msg}${t.reset}`]);
      },
      requestRender: () => this.renderer.requestRender(),
    });

    this.commandHandler = createCommandHandler({
      getRpcClient: () => this.rpcClient,
      getCurrentThreadId: () => this.runtime.currentThreadId,
      getConfig: () => this.config,
      getCommandRegistry: () => this.commandRegistry,
      getSkills: () => this.skills,
      getCurrentMode: () => this.runtime.currentMode,
      getCurrentEffort: () => this.runtime.currentEffort,
      getIsProcessing: () => this.runtime.isProcessing,
      setIsProcessing: (val) => {
        this.runtime.isProcessing = val;
        if (!val) {
          this.runtime.cancelRequested = false;
        }
        this.inputEditor.setBusy(val);
      },
      setPendingTurn: (turn) => {
        this.runtime.pendingTurn = turn;
      },
      addUserMessage: (text) => this.chatView.addUserMessage(text),
      addLines: (lines) => this.chatView.addLines(lines),
      clearActive: () => this.chatView.clearActive(),
      clearChatHistory: () => {
        this.chatView.clearHistory();
        this.runtime.pendingSteers = [];
        this.viewModel.prompt.setPendingSteers(this.runtime.pendingSteers);
        this.viewModel.status.resetUsage();
        this.chatView.addLines(
          buildWelcomeBanner({
            version: pkgVersion,
            modelId: this.config.model.id,
            cwd: process.cwd(),
            terminalColumns: this.terminal.columns,
            yolo: Boolean(this.config.diligent.yolo),
          }),
        );
      },
      clearScreenAndResetRenderer: () => {
        this.terminal.clearScreen();
        this.renderer.resetFrameState();
      },
      handleAgentStartEvent: () => this.chatView.handleEvent({ type: "agent_start" }),
      finishTurn: () => this.chatView.finishTurn(),
      handleTurnError: (err) => {
        this.chatView.handleEvent({
          type: "error",
          error: {
            message: err instanceof Error ? err.message : String(err),
            name: err instanceof Error ? err.name : "Error",
          },
          fatal: false,
        });
      },
      updateStatusBar: (updates) => this.statusBar.update(updates),
      requestRender: () => this.renderer.requestRender(),
      confirm: (o) => this.dialogs.confirm(o),
      pickInline: (o) => this.dialogs.pickInline(o),
      promptInline: (o) => this.dialogs.promptInline(o),
      shutdown: () => this.shutdown(),
      onModelChanged: (modelId) => {
        this.statusBar.update({ model: modelId });
        this.renderer.requestRender();
      },
      onEffortChanged: (effort, label) => {
        this.runtime.currentEffort = effort;
        this.statusBar.update({ effort, effortLabel: label });
        this.renderer.requestRender();
      },
      waitForOAuthComplete: () =>
        new Promise((resolve) => {
          this.runtime.pendingOAuthResolve = resolve;
        }),
      waitForMcpLogin: (server: string) =>
        new Promise((resolve) => {
          this.runtime.pendingMcpLoginResolve.set(server, resolve);
        }),
      syncActiveThreadState: () => this.syncActiveThreadState(),
      queuePendingSteer: (text) => {
        this.runtime.queuePendingSteer(text);
        this.viewModel.prompt.setPendingSteers(this.runtime.pendingSteers);
      },
      threadManager: this.threadManager,
      configManager: this.configManager,
    });

    this.setupWizard = createSetupWizard({
      config: this.config,
      addLines: (lines) => this.chatView.addLines(lines),
      requestRender: () => this.renderer.requestRender(),
      buildCommandContext: () => this.commandHandler.buildCommandContext(),
      updateStatusBar: (updates) => this.viewModel.status.update(updates),
    });
    this.sessionLifecycle = new AppSessionLifecycle({
      config: this.config,
      runtime: this.runtime,
      terminal: this.terminal,
      renderer: this.renderer,
      inputHistory: this.inputHistory,
      inputEditor: this.inputEditor,
      statusBar: this.statusBar,
      chatView: this.chatView,
      setupWizard: this.setupWizard,
      threadManager: this.threadManager,
      pathsAvailable: Boolean(this.paths),
      getRpcClient: () => this.rpcClient,
      restartRpcClient: () => this.restartRpcClient(),
      options: this.options,
      pkgVersion,
    });
  }

  async start(): Promise<void> {
    this.terminal.start(
      (data) => this.handleInput(data),
      () => this.renderer.requestRender(),
    );
    await this.sessionLifecycle.start();
  }

  private async restartRpcClient(): Promise<void> {
    this.rpcClient?.setNotificationListener(null);
    this.rpcClient?.setServerRequestHandler(null);
    await this.rpcClient?.dispose().catch(() => {});
    const spawnFn = this.options?.rpcClientFactory ?? spawnCliAppServer;
    this.rpcClient = await spawnFn({
      cwd: process.cwd(),
      yolo: this.config.diligent.yolo,
      onStderrLine: (line) => this.handleAppServerStderr(line),
    });
    this.rpcClient.setNotificationListener((notification) => this.handleServerNotification(notification));
    this.rpcClient.setServerRequestHandler((requestId, request) => this.handleServerRequest(requestId, request));
  }

  private handleInput(data: string): void {
    const sequences = this.stdinBuffer.split(data);

    for (const seq of sequences) {
      // Inline question in chat takes input priority over the editor.
      if (this.chatView.hasActiveQuestion()) {
        this.chatView.handleQuestionInput(seq);
        this.renderer.requestRender();
        continue;
      }

      // Shift+Tab: cycle collaboration mode
      if (matchesKey(seq, "shift+tab")) {
        this.cycleMode();
        continue;
      }

      // Ctrl+O: expand/collapse tool result details
      if (matchesKey(seq, "ctrl+o")) {
        this.chatView.toggleToolResultsCollapsed();
        continue;
      }

      if (matchesKey(seq, "ctrl+c") || matchesKey(seq, "escape")) {
        this.handleCancel();
      } else {
        this.inputEditor.handleInput(seq);
      }
    }
  }

  private cycleMode(): void {
    const modes: ProtocolMode[] = ["default", "plan", "execute"];
    const idx = modes.indexOf(this.runtime.currentMode);
    const next = modes[(idx + 1) % modes.length];
    this.configManager.setMode(next);
  }

  private beginCompactionIndicator(estimatedTokens: number): void {
    this.chatView.handleEvent({ type: "compaction_start", estimatedTokens });
    if (!this.runtime.isProcessing) {
      this.inputEditor.setBusy(true);
    }
  }

  private endCompactionIndicator(tokensBefore: number, tokensAfter: number, summary: string): void {
    this.chatView.handleEvent({ type: "compaction_end", tokensBefore, tokensAfter, summary });
    if (!this.runtime.isProcessing) {
      this.inputEditor.setBusy(false);
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (event.type === "compaction_start") {
      this.beginCompactionIndicator(event.estimatedTokens);
      return;
    }

    if (event.type === "compaction_end") {
      this.endCompactionIndicator(event.tokensBefore, event.tokensAfter, event.summary);
      return;
    }
    if (event.type === "steering_injected") {
      const injectedTexts = event.messages
        .map((message) => {
          if (message.role !== "user") return null;
          if (typeof message.content === "string") return message.content;
          const text = message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
            .trim();
          return text.length > 0 ? text : null;
        })
        .filter((content): content is string => content !== null);

      if (this.suppressNextSteeringInjectedCommit) {
        this.suppressNextSteeringInjectedCommit = false;
        this.viewModel.prompt.setPendingSteers(this.runtime.pendingSteers);
        return;
      }

      const expectedCount = Math.max(0, event.messageCount);
      const consumed = this.runtime.consumePendingSteersByText(injectedTexts);
      const fallbackCount = Math.max(0, (expectedCount > 0 ? expectedCount : injectedTexts.length) - consumed.length);
      if (fallbackCount > 0) {
        consumed.push(...this.runtime.consumePendingSteersFallback(fallbackCount));
      }
      if (consumed.length === 0 && injectedTexts.length > 0) {
        consumed.push(...injectedTexts.slice(0, expectedCount > 0 ? expectedCount : injectedTexts.length));
      }
      this.viewModel.prompt.setPendingSteers(this.runtime.pendingSteers);

      if (consumed.length > 0) {
        this.chatView.commitSteeringMessages(consumed);
        this.pendingUserMessageAcks.push(...consumed);
      }
    }

    this.chatView.handleEvent(event);

    if (event.type === "turn_start" && !event.childThreadId) {
      this.runtime.beginTurnTiming();
    }

    if (event.type === "message_delta") {
      if (event.delta.type === "thinking_delta") {
        this.runtime.noteThinkingDelta();
      } else {
        this.runtime.noteTextDelta();
      }
    }

    if (event.type === "message_end") {
      this.runtime.noteMessageEnd();
    }

    if (event.type === "user_message") {
      const content = event.message.content;
      const text =
        typeof content === "string"
          ? content
          : content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n")
              .trim();
      if (text.length > 0) {
        this.handleRemoteUserMessage(text);
      }
    }

    // Update status bar with usage info
    if (event.type === "usage") {
      this.statusBar.update({
        tokensUsed: event.usage.inputTokens + event.usage.cacheReadTokens + event.usage.cacheWriteTokens,
      });
      this.renderer.requestRender();
    } else if (event.type === "status_change") {
      this.statusBar.update({ status: event.status });
      this.renderer.requestRender();
    }
  }

  private handleCancel(): void {
    if (this.runtime.isProcessing && this.rpcClient && this.runtime.currentThreadId) {
      if (this.runtime.cancelRequested) {
        this.runtime.cancelRequested = false;
        this.runtime.isProcessing = false;
        this.runtime.pendingTurn = null;
        this.inputEditor.setBusy(false);
        this.statusBar.update({ status: "idle" });
        this.renderer.requestRender();
        return;
      }
      this.runtime.cancelRequested = true;
      const drainedSteers = this.chatView.consumePendingSteers();
      const drainedRuntimeSteers = this.runtime.drainPendingSteers();
      this.pendingAbortRestartMessage = drainedRuntimeSteers[0] ?? drainedSteers[0] ?? null;
      this.suppressNextSteeringInjectedCommit = this.pendingAbortRestartMessage !== null;
      this.viewModel.prompt.setPendingSteers([]);
      this.chatView.clearActiveWithCommit();
      this.chatView.addLines([`  ${t.dim}Cancelled.${t.reset}`]);
      void this.rpcClient
        .request(DILIGENT_CLIENT_REQUEST_METHODS.TURN_INTERRUPT, { threadId: this.runtime.currentThreadId })
        .catch(() => {
          this.runtime.cancelRequested = false;
          this.pendingAbortRestartMessage = null;
          this.suppressNextSteeringInjectedCommit = false;
        });
    } else if (!this.runtime.isProcessing) {
      this.shutdown();
    }
  }

  private commitLocalUserMessage(text: string): void {
    this.chatView.addUserMessage(text);
    this.pendingUserMessageAcks.push(text);
  }

  private handleRemoteUserMessage(text: string): void {
    const index = this.pendingUserMessageAcks.indexOf(text);
    if (index !== -1) {
      this.pendingUserMessageAcks.splice(index, 1);
      return;
    }
    this.chatView.addUserMessage(text);
  }

  private async restartFromPendingAbortSteer(threadId: string): Promise<void> {
    const rpc = this.rpcClient;
    const restartMessage = this.pendingAbortRestartMessage;
    if (!rpc || !restartMessage) {
      return;
    }

    this.pendingAbortRestartMessage = null;
    this.runtime.isProcessing = true;
    this.inputEditor.setBusy(true);
    this.statusBar.update({ status: "busy" });
    this.commitLocalUserMessage(restartMessage);
    try {
      await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.TURN_START, {
        threadId,
        message: restartMessage,
        content: [{ type: "text", text: restartMessage }],
        model: this.config.model.id || undefined,
      });
    } catch (error) {
      this.runtime.isProcessing = false;
      this.runtime.cancelRequested = false;
      this.inputEditor.setBusy(false);
      this.statusBar.update({ status: "idle" });
      this.chatView.handleEvent({
        type: "error",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
        fatal: false,
      });
      this.renderer.requestRender();
    }
  }

  private handleAppServerStderr(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || !this.paths) {
      return;
    }

    if (!this.runtime.currentThreadId) {
      this.pendingAppServerLogLines.push(trimmed);
      return;
    }

    this.updateAppServerLogSession(this.runtime.currentThreadId);
    this.appendToCurrentAppServerLog(trimmed);
  }

  private updateAppServerLogSession(sessionId: string | null): void {
    if (!sessionId || !this.paths) {
      return;
    }
    if (this.currentAppServerLogSessionId === sessionId) {
      return;
    }

    const logsDir = join(this.paths.root, "logs");
    if (!this.appServerLogDirInitialized) {
      mkdirSync(logsDir, { recursive: true });
      this.appServerLogDirInitialized = true;
    }

    this.currentAppServerLogSessionId = sessionId;
    const logPath = this.getCurrentAppServerLogPath();
    if (logPath) {
      appendFileSync(logPath, "");
    }
    if (this.pendingAppServerLogLines.length > 0) {
      for (const pendingLine of this.pendingAppServerLogLines) {
        this.appendToCurrentAppServerLog(pendingLine);
      }
      this.pendingAppServerLogLines = [];
    }
  }

  private getCurrentAppServerLogPath(): string | null {
    if (!this.paths || !this.currentAppServerLogSessionId) {
      return null;
    }
    return join(this.paths.root, "logs", `${this.currentAppServerLogSessionId}.app-server.log`);
  }

  private appendToCurrentAppServerLog(line: string): void {
    const logPath = this.getCurrentAppServerLogPath();
    if (!logPath) {
      return;
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  }

  private async handleServerNotification(notification: DiligentServerNotification): Promise<void> {
    await this.eventController.handleServerNotification(notification);

    if (
      notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_INTERRUPTED &&
      notification.params.threadId === this.runtime.currentThreadId &&
      this.pendingAbortRestartMessage
    ) {
      const interruptedThreadId = notification.params.threadId;
      queueMicrotask(() => {
        void this.restartFromPendingAbortSteer(interruptedThreadId);
      });
    }
  }

  private async syncActiveThreadState(): Promise<void> {
    await this.sessionLifecycle.syncActiveThreadState();
  }

  private async handleServerRequest(
    requestId: RequestId,
    request: DiligentServerRequest,
  ): Promise<DiligentServerRequestResponse> {
    return this.eventController.handleServerRequest(requestId, request);
  }

  private ringTerminalBell(): void {
    if (!this.shouldBellOnComplete) {
      return;
    }
    this.terminal.bell();
  }

  private appendLocalTurnTimingLine(): void {
    const now = Date.now();
    const loopMs = this.runtime.turnStartedAtMs !== null ? Math.max(0, now - this.runtime.turnStartedAtMs) : null;
    const thinkingMs =
      this.runtime.reasoningStartedAtMs !== null
        ? this.runtime.reasoningAccumulatedMs + (now - this.runtime.reasoningStartedAtMs)
        : this.runtime.reasoningAccumulatedMs;
    const line = buildTurnTimingLine({ loopMs, thinkingMs });
    if (line) {
      this.chatView.addLines([line], { separateBefore: true });
    }

    this.runtime.turnStartedAtMs = null;
    this.runtime.reasoningStartedAtMs = null;
    this.runtime.reasoningAccumulatedMs = 0;
  }

  async confirm(options: ConfirmDialogOptions): Promise<boolean> {
    return this.dialogs.confirm(options);
  }

  /** Stop the TUI */
  stop(): void {
    if (this.streamRenderTimer) {
      clearTimeout(this.streamRenderTimer);
      this.streamRenderTimer = null;
    }
    this.renderer.stop();
    this.terminal.stop();
    void this.rpcClient?.dispose().catch(() => {});
  }

  private shutdown(): void {
    this.stop();
    this.terminal.write(buildShutdownMessage(this.runtime.currentThreadId));
    process.exit(0);
  }

  private static resolveStreamRenderBatchMs(): number {
    const raw = process.env.DILIGENT_TUI_STREAM_BATCH_MS;
    if (!raw) return App.DEFAULT_STREAM_RENDER_BATCH_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return App.DEFAULT_STREAM_RENDER_BATCH_MS;
    return Math.max(16, parsed);
  }
}
