// @summary Synchronous, failure-isolated extension points for the core agent loop

import type { Logger } from "@diligent/logging";
import type { AssistantMessage, Message, ToolCallBlock, ToolResultMessage, UserMessage } from "../types";

export interface AgentContextInjection {
  /** Opaque diagnostic/persistence label. Core never branches on this value. */
  source: string;
  /** Only user content may be inserted between provider sampling rounds. */
  content: UserMessage["content"];
  /** Opaque trusted-extension metadata. Core forwards it without interpretation. */
  metadata?: Record<string, unknown>;
}

export interface AgentLoopHookRestoreContext {
  messages: readonly Message[];
}

export interface AgentLoopHookPromptStartContext {
  messages: readonly Message[];
}

export interface AgentLoopHookBeforeTurnContext {
  messages: readonly Message[];
  turnId: string;
  compactedThisTurn: boolean;
}

export interface AgentLoopHookToolResultContext {
  turnId: string;
  toolCall: ToolCallBlock;
  result: ToolResultMessage;
}

export interface AgentLoopHookAfterTurnContext {
  turnId: string;
  message: AssistantMessage;
  toolResults: readonly ToolResultMessage[];
}

export interface AgentLoopHook {
  /** Stable within one Agent for diagnostics and duplicate detection. */
  id: string;
  restore?(context: AgentLoopHookRestoreContext): void;
  onPromptStart?(context: AgentLoopHookPromptStartContext): void;
  beforeTurn?(context: AgentLoopHookBeforeTurnContext): readonly AgentContextInjection[] | undefined;
  onToolResult?(context: AgentLoopHookToolResultContext): void;
  afterTurn?(context: AgentLoopHookAfterTurnContext): void;
}

type HookPhase = "restore" | "onPromptStart" | "beforeTurn" | "onToolResult" | "afterTurn";

/** Internal deterministic dispatcher shared by Agent restore and loop execution. */
export class AgentLoopHookDispatcher {
  private readonly disabledIds = new Set<string>();

  constructor(
    private readonly hooks: readonly AgentLoopHook[],
    private readonly logger: Logger,
  ) {
    const ids = new Set<string>();
    for (const hook of hooks) {
      if (hook.id.trim().length === 0) throw new Error("Agent loop hook id must be non-empty");
      if (ids.has(hook.id)) throw new Error(`Duplicate agent loop hook id: ${hook.id}`);
      ids.add(hook.id);
    }
  }

  restore(messages: readonly Message[]): void {
    this.dispatch("restore", (hook) => hook.restore?.({ messages: [...messages] }));
  }

  onPromptStart(messages: readonly Message[]): void {
    this.dispatch("onPromptStart", (hook) => hook.onPromptStart?.({ messages: [...messages] }));
  }

  beforeTurn(context: AgentLoopHookBeforeTurnContext): AgentContextInjection[] {
    const injections: AgentContextInjection[] = [];
    this.dispatch("beforeTurn", (hook) => {
      const returned = hook.beforeTurn?.({ ...context, messages: [...context.messages] });
      if (!returned) return;
      const hookInjections: AgentContextInjection[] = [];
      for (const injection of returned) {
        if (typeof injection.source !== "string" || injection.source.trim().length === 0) {
          throw new Error("Agent context injection source must be non-empty");
        }
        hookInjections.push({ source: injection.source, content: injection.content, metadata: injection.metadata });
      }
      injections.push(...hookInjections);
    });
    return injections;
  }

  onToolResult(context: AgentLoopHookToolResultContext): void {
    this.dispatch("onToolResult", (hook) => hook.onToolResult?.(context));
  }

  afterTurn(context: AgentLoopHookAfterTurnContext): void {
    this.dispatch("afterTurn", (hook) => hook.afterTurn?.({ ...context, toolResults: [...context.toolResults] }));
  }

  private dispatch(phase: HookPhase, invoke: (hook: AgentLoopHook) => void): void {
    for (const hook of this.hooks) {
      if (this.disabledIds.has(hook.id)) continue;
      try {
        invoke(hook);
      } catch (error) {
        this.disabledIds.add(hook.id);
        this.logger.warn("agent_loop_hook_disabled", {
          message: `[agent:loop-hook] disabled hook=${hook.id} phase=${phase}`,
          error,
          fields: { hookId: hook.id, phase },
        });
      }
    }
  }
}
