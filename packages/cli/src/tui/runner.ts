// @summary Non-interactive runner using JSON-RPC app-server communication

import type { AgentEvent, DiligentServerNotification } from "@diligent/protocol";
import {
  DILIGENT_CLIENT_NOTIFICATION_METHODS,
  DILIGENT_CLIENT_REQUEST_METHODS,
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  DILIGENT_VERSION,
} from "@diligent/protocol";
import type { DiligentPaths } from "@diligent/runtime";
import type { AppConfig } from "../config";
import type { SpawnedAppServer } from "./rpc-client";
import { type SpawnRpcClientOptions, spawnCliAppServer } from "./rpc-framed-client";
import { t } from "./theme";

export interface RunnerOptions {
  resume?: boolean;
  rpcClientFactory?: (options: SpawnRpcClientOptions) => Promise<SpawnedAppServer>;
}

const APP_SERVER_STDERR_PREFIX = "[app-server]";

export class NonInteractiveRunner {
  private exitCode = 0;
  private isThinking = false;
  private shouldBellOnComplete = true;

  constructor(
    private config: AppConfig,
    private paths?: DiligentPaths,
    private options?: RunnerOptions,
  ) {}

  async run(prompt: string): Promise<number> {
    this.shouldBellOnComplete = this.config.diligent.terminalBell !== false;

    if (!this.paths) {
      this.writeStderr("[error] No .diligent directory — non-interactive mode is unavailable.", false);
      return 1;
    }

    const isTTY = process.stderr.isTTY === true;
    let hasText = false;
    let threadId: string | null = null;

    let pendingTurn: {
      resolve: () => void;
      reject: (error: Error) => void;
    } | null = null;

    const spawnFn = this.options?.rpcClientFactory ?? spawnCliAppServer;
    const rpc = await spawnFn({
      cwd: process.cwd(),
      yolo: this.config.diligent.yolo,
      onStderrLine: (line) => {
        const trimmed = line.trim();
        if (trimmed) {
          this.writeStderr(`${APP_SERVER_STDERR_PREFIX} ${trimmed}`, isTTY);
        }
      },
    });
    rpc.setNotificationListener((notification: DiligentServerNotification) => {
      const events =
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT ? [notification.params.event] : [];
      for (const event of events) {
        hasText = this.handleEvent(event, isTTY, hasText);
      }

      if (
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.TURN_COMPLETED &&
        threadId &&
        notification.params.threadId === threadId
      ) {
        this.ringTerminalBell();
        pendingTurn?.resolve();
      }

      if (
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.ERROR &&
        (!notification.params.threadId || notification.params.threadId === threadId)
      ) {
        pendingTurn?.reject(new Error(notification.params.error.message));
      }

      if (
        notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.AGENT_EVENT &&
        notification.params.event.type === "error"
      ) {
        pendingTurn?.reject(new Error(notification.params.event.error.message));
      }
    });

    try {
      await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.INITIALIZE, {
        clientName: "diligent-cli",
        clientVersion: DILIGENT_VERSION,
        protocolVersion: 1,
      });
      await rpc.notify(DILIGENT_CLIENT_NOTIFICATION_METHODS.INITIALIZED, { ready: true });

      if (this.options?.resume) {
        const resumed = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_RESUME, { mostRecent: true });
        if (resumed.found && resumed.threadId) {
          threadId = resumed.threadId;
        }
      }

      if (!threadId) {
        const started = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_START, {
          cwd: process.cwd(),
          mode: this.config.mode,
        });
        threadId = started.threadId;
      }

      if (threadId) {
        await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_SUBSCRIBE, { threadId });
      }

      const turnDone = new Promise<void>((resolve, reject) => {
        pendingTurn = { resolve, reject };
      });

      await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.TURN_START, {
        threadId,
        message: prompt,
      });
      await turnDone;
    } catch (err) {
      this.writeStderr(`[error] ${err instanceof Error ? err.message : String(err)}`, isTTY);
      this.exitCode = 1;
    } finally {
      await rpc.dispose().catch(() => {});
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

      case "compaction_end": {
        this.writeStderr(
          `[compaction] ${Math.round(event.tokensBefore / 1000)}k -> ${Math.round(event.tokensAfter / 1000)}k tokens`,
          isTTY,
        );
        return hasText;
      }

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
      process.stderr.write(`${t.dim}${msg}${t.reset}\n`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
  }

  private ringTerminalBell(): void {
    if (!this.shouldBellOnComplete) {
      return;
    }
    process.stderr.write("\x07");
  }
}
