// @summary Factory for command dispatch, user submit, steering, and CommandContext assembly

import { randomUUID } from "node:crypto";
import type { PendingSteer, Mode as ProtocolMode, ThinkingEffort } from "@diligent/protocol";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import type { SkillMetadata } from "@diligent/runtime";
import type { AppConfig } from "../config";
import { parseCommand } from "./commands/parser";
import type { CommandRegistry } from "./commands/registry";
import type { CommandContext } from "./commands/types";
import type { ConfirmDialogOptions } from "./components/confirm-dialog";
import type { ConfigManager } from "./config-manager";
import type { AppServerRpcClient } from "./rpc-client";
import { t } from "./theme";
import type { ThreadManager } from "./thread-manager";

export interface CommandHandlerDeps {
  getRpcClient: () => AppServerRpcClient | null;
  getCurrentThreadId: () => string | null;
  getConfig: () => AppConfig;
  getCommandRegistry: () => CommandRegistry;
  getSkills: () => SkillMetadata[];
  getCurrentMode: () => ProtocolMode;
  getCurrentEffort: () => ThinkingEffort;
  getIsProcessing: () => boolean;
  setIsProcessing: (val: boolean) => void;
  setPendingTurn: (turn: { resolve: () => void; reject: (error: Error) => void } | null) => void;
  // UI callbacks
  addUserMessage: (text: string) => void;
  addLines: (lines: string[]) => void;
  clearActive: () => void;
  clearChatHistory: () => void;
  clearScreenAndResetRenderer: () => void;
  handleAgentStartEvent: () => void;
  finishTurn: () => void;
  handleTurnError: (err: unknown) => void;
  updateStatusBar: (updates: Record<string, unknown>) => void;
  requestRender: () => void;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  pickInline: (options: {
    title: string;
    items: Array<{ label: string; description?: string; value: string; header?: boolean }>;
    selectedIndex?: number;
    filterable?: boolean;
  }) => Promise<string | null>;
  promptInline: (options: {
    title: string;
    message?: string;
    placeholder?: string;
    masked?: boolean;
    minimal?: boolean;
  }) => Promise<string | null>;
  shutdown: () => void;
  onModelChanged: (modelId: string) => void;
  onEffortChanged: (effort: ThinkingEffort, label: string) => void;
  waitForOAuthComplete: () => Promise<{ success: boolean; error: string | null }>;
  syncActiveThreadState: () => Promise<void>;
  queuePendingSteer: (steer: PendingSteer) => void;
  // Domain modules
  threadManager: ThreadManager;
  configManager: ConfigManager;
}

export interface CommandHandler {
  handleSubmit: (text: string) => Promise<void>;
  handleCommand: (name: string, args: string | undefined) => Promise<void>;
  buildCommandContext: () => CommandContext;
  handleSteering: (text: string) => void;
}

export function createCommandHandler(deps: CommandHandlerDeps): CommandHandler {
  const handler: CommandHandler = {
    async handleSubmit(text: string): Promise<void> {
      // Check for slash command
      const parsed = parseCommand(text);
      if (parsed) {
        await handler.handleCommand(parsed.name, parsed.args);
        return;
      }

      const rpc = deps.getRpcClient();
      if (!rpc) {
        deps.addLines([`  ${t.error}App server is not initialized.${t.reset}`]);
        deps.requestRender();
        return;
      }

      let threadId = deps.getCurrentThreadId();
      if (!threadId) {
        await deps.threadManager.startNewThread();
        await deps.syncActiveThreadState();
        threadId = deps.getCurrentThreadId();
      }
      if (!threadId) {
        deps.addLines([`  ${t.error}No active thread.${t.reset}`]);
        deps.requestRender();
        return;
      }

      deps.setIsProcessing(true);
      deps.addUserMessage(text);
      deps.handleAgentStartEvent();
      deps.updateStatusBar({ status: "busy" });
      deps.requestRender();

      try {
        const turnCompleted = new Promise<void>((resolve, reject) => {
          deps.setPendingTurn({ resolve, reject });
        });
        await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.TURN_START, {
          threadId,
          message: text,
          model: deps.getConfig().model.id,
        });
        await turnCompleted;
      } catch (err) {
        deps.handleTurnError(err);
        deps.setPendingTurn(null);
        deps.setIsProcessing(false);
        deps.finishTurn();
        deps.updateStatusBar({ status: "idle" });
        deps.requestRender();
      }
    },

    async handleCommand(name: string, args: string | undefined): Promise<void> {
      const registry = deps.getCommandRegistry();
      const command = registry.get(name);
      if (!command) {
        deps.addLines([`  ${t.error}Unknown command: /${name}${t.reset}`, "  Type /help for available commands."]);
        deps.requestRender();
        return;
      }

      if (deps.getIsProcessing() && !command.availableDuringTask) {
        deps.addLines([`  ${t.warn}Command not available while agent is running.${t.reset}`]);
        deps.requestRender();
        return;
      }

      const ctx = handler.buildCommandContext();
      try {
        await command.handler(args, ctx);
      } catch (err) {
        deps.addLines([`  ${t.error}Command error: ${err instanceof Error ? err.message : String(err)}${t.reset}`]);
      }
      deps.requestRender();
    },

    buildCommandContext(): CommandContext {
      return {
        app: {
          confirm: (o) => deps.confirm(o),
          pick: (o) => deps.pickInline(o),
          prompt: (o) => deps.promptInline(o),
          stop: () => deps.shutdown(),
          getRpcClient: () => deps.getRpcClient(),
          waitForOAuthComplete: () => deps.waitForOAuthComplete(),
        },
        config: deps.getConfig(),
        threadId: deps.getCurrentThreadId(),
        skills: deps.getSkills(),
        registry: deps.getCommandRegistry(),
        requestRender: () => deps.requestRender(),
        displayLines: (lines) => {
          deps.addLines(lines);
          deps.requestRender();
        },
        displayError: (msg) => {
          deps.addLines([`  ${t.error}${msg}${t.reset}`]);
          deps.requestRender();
        },
        runAgent: (text) => handler.handleSubmit(text),
        reload: () => deps.configManager.reloadConfig(),
        currentMode: deps.getCurrentMode(),
        setMode: (mode) => deps.configManager.setMode(mode),
        currentEffort: deps.getCurrentEffort(),
        setEffort: (effort) => deps.configManager.setEffort(effort),
        setModel: (modelId) => deps.configManager.setModel(modelId),
        clearChatHistory: () => deps.clearChatHistory(),
        clearScreenAndResetRenderer: () => deps.clearScreenAndResetRenderer(),
        startNewThread: async () => {
          const threadId = await deps.threadManager.startNewThread();
          await deps.syncActiveThreadState();
          return threadId;
        },
        resumeThread: async (threadId) => {
          const resumedThreadId = await deps.threadManager.resumeThread(threadId);
          if (resumedThreadId) {
            await deps.syncActiveThreadState();
          }
          return resumedThreadId;
        },
        deleteThread: async (threadId) => {
          const deleted = await deps.threadManager.deleteThread(threadId);
          if (deleted) {
            await deps.syncActiveThreadState();
          }
          return deleted;
        },
        listThreads: () => deps.threadManager.listThreads(),
        readThread: () => deps.threadManager.readThread(),
        onModelChanged: (modelId) => deps.onModelChanged(modelId),
        onEffortChanged: (effort, label) => deps.onEffortChanged(effort, label),
      };
    },

    handleSteering(text: string): void {
      const rpc = deps.getRpcClient();
      const threadId = deps.getCurrentThreadId();
      if (!rpc || !threadId) return;
      const steerId = `steer-${randomUUID()}`;
      deps.queuePendingSteer({ id: steerId, content: text });
      deps.requestRender();
      void rpc
        .request(DILIGENT_CLIENT_REQUEST_METHODS.TURN_STEER, {
          threadId,
          steerId,
          content: text,
          followUp: false,
        })
        .catch(() => {});
    },
  };

  return handler;
}
