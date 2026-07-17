// @summary Shared OpenAI-family content buffering and exactly-once assistant-message finalization
import type { AssistantMessage, ContentBlock, StopReason, Usage } from "../../../types";
import type { ProviderEvent } from "../../types";

type ToolBuffer = {
  id: string;
  name: string;
  arguments: string;
  order: number;
  started: boolean;
};

export interface ToolCallUpdate {
  id?: string;
  name?: string;
  order: number;
}

export interface CompleteToolCallOptions {
  id?: string;
  name?: string;
  arguments?: string;
  parseArguments: (argumentsText: string) => Record<string, unknown>;
}

export interface OpenAIContentFinalizationOptions {
  modelId: string;
  finalizePendingTools: boolean;
  parseToolArguments?: (argumentsText: string) => Record<string, unknown>;
  flushThinking?: boolean;
  thinkingPosition?: "append" | "prepend";
  flushText?: boolean;
}

export interface OpenAIContentFinalization {
  events: ProviderEvent[];
  message: AssistantMessage;
}

const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export class OpenAIContentAccumulator {
  private readonly contentBlocks: ContentBlock[] = [];
  private readonly toolBuffers = new Map<string, ToolBuffer>();
  private currentText = "";
  private currentThinking = "";
  private thinkingEnded = false;
  private usage: Usage = { ...EMPTY_USAGE };
  private stopReason: StopReason = "end_turn";
  private finalized = false;

  appendTextDelta(delta: string): ProviderEvent[] {
    if (!delta || this.finalized) return [];
    this.currentText += delta;
    return [{ type: "text_delta", delta }];
  }

  appendThinkingDelta(delta: string): ProviderEvent[] {
    if (!delta || this.finalized) return [];
    if (!this.thinkingEnded) this.currentThinking += delta;
    return [{ type: "thinking_delta", delta }];
  }

  flushThinking(fallback = "", position: "append" | "prepend" = "append"): ProviderEvent[] {
    const thinking = this.currentThinking || fallback;
    if (!thinking) return [];
    this.currentThinking = "";
    this.thinkingEnded = true;
    const block: ContentBlock = { type: "thinking", thinking };
    if (position === "prepend") this.contentBlocks.unshift(block);
    else this.contentBlocks.push(block);
    return [{ type: "thinking_end", thinking }];
  }

  flushText(): ProviderEvent[] {
    if (!this.currentText) return [];
    const text = this.currentText;
    this.currentText = "";
    this.contentBlocks.push({ type: "text", text });
    return [{ type: "text_end", text }];
  }

  acceptAuthoritativeMessage(blocks: ContentBlock[]): ProviderEvent[] {
    if (blocks.length === 0 || this.finalized) return [];
    this.currentText = "";
    const events: ProviderEvent[] = [];
    for (const block of blocks) {
      this.contentBlocks.push(block);
      if (block.type === "text") events.push({ type: "text_end", text: block.text });
    }
    return events;
  }

  addContentBlock(block: ContentBlock, position: "append" | "prepend" = "append"): void {
    if (this.finalized) return;
    if (position === "prepend") this.contentBlocks.unshift(block);
    else this.contentBlocks.push(block);
  }

  upsertToolCall(key: string, update: ToolCallUpdate): ProviderEvent[] {
    if (this.finalized) return [];
    const buffer = this.toolBuffers.get(key) ?? {
      id: update.id ?? key,
      name: update.name ?? "unknown_tool",
      arguments: "",
      order: update.order,
      started: false,
    };
    if (update.id) buffer.id = update.id;
    if (update.name) buffer.name = update.name;
    buffer.order = update.order;
    this.toolBuffers.set(key, buffer);
    if (buffer.started || !buffer.name || buffer.name === "unknown_tool") return [];
    buffer.started = true;
    return [{ type: "tool_call_start", id: buffer.id, name: buffer.name }];
  }

  appendToolArguments(key: string, delta: string): ProviderEvent[] {
    if (!delta || this.finalized) return [];
    const buffer = this.toolBuffers.get(key);
    if (!buffer) return [];
    buffer.arguments += delta;
    return [{ type: "tool_call_delta", id: buffer.id, delta }];
  }

  completeToolCall(key: string, options: CompleteToolCallOptions): ProviderEvent[] {
    const buffer = this.toolBuffers.get(key);
    const id = options.id ?? buffer?.id ?? key;
    const name = options.name ?? buffer?.name ?? "unknown_tool";
    const argumentsText = options.arguments ?? buffer?.arguments ?? "";
    const input = options.parseArguments(argumentsText);
    this.toolBuffers.delete(key);
    this.contentBlocks.push({ type: "tool_call", id, name, input });
    return [{ type: "tool_call_end", id, name, input }];
  }

  setUsage(usage: Usage): void {
    this.usage = usage;
  }

  setStopReason(stopReason: StopReason): void {
    this.stopReason = stopReason;
  }

  abort(): void {
    this.finalized = true;
  }

  finalize(options: OpenAIContentFinalizationOptions): OpenAIContentFinalization | undefined {
    if (this.finalized) return undefined;
    this.finalized = true;
    const events: ProviderEvent[] = [];

    if (options.flushThinking !== false) {
      events.push(...this.flushThinking("", options.thinkingPosition));
    }
    if (options.flushText !== false) events.push(...this.flushText());

    if (options.finalizePendingTools) {
      if (!options.parseToolArguments) {
        throw new Error("parseToolArguments is required when finalizing pending tool calls");
      }
      const pendingTools = [...this.toolBuffers.entries()].sort((left, right) => left[1].order - right[1].order);
      for (const [key] of pendingTools) {
        events.push(
          ...this.completeToolCall(key, {
            parseArguments: options.parseToolArguments,
          }),
        );
      }
    }

    events.push({ type: "usage", usage: this.usage });
    const message: AssistantMessage = {
      role: "assistant",
      content: this.contentBlocks,
      model: options.modelId,
      usage: this.usage,
      stopReason: this.stopReason,
      timestamp: Date.now(),
    };
    events.push({ type: "done", stopReason: this.stopReason, message });
    return { events, message };
  }
}
