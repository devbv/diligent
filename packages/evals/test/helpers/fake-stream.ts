// @summary Test helpers for deterministic provider streams and eval task fixtures

import { EventStream } from "@diligent/core/event-stream";
import type { AssistantMessage } from "@diligent/core/message-contract";
import type {
  Model,
  ProviderEvent,
  ProviderResult,
  StreamContext,
  StreamFunction,
  StreamOptions,
} from "@diligent/core/provider-contract";

export const TEST_MODEL: Model = {
  modelId: "test-model",
  provider: "anthropic",
  contextWindow: 100_000,
  maxOutputTokens: 16_384,
  supportsThinking: false,
};

export function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "end_turn",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: TEST_MODEL,
    usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason,
    timestamp: Date.now(),
  };
}

export function sequenceStream(
  messages: AssistantMessage[],
  options: { emitTextDeltas?: boolean } = {},
): StreamFunction {
  let index = 0;
  return (_model: Model, _context: StreamContext, streamOptions: StreamOptions) => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );
    if (streamOptions.signal) stream.attachSignal(streamOptions.signal);
    const message = messages[index++];
    queueMicrotask(() => {
      stream.push({ type: "start" });
      for (const block of message.content) {
        if (block.type === "text" && options.emitTextDeltas !== false) {
          stream.push({ type: "text_delta", delta: block.text });
        }
        if (block.type === "tool_call") {
          stream.push({ type: "tool_call_start", id: block.id, name: block.name });
          stream.push({ type: "tool_call_end", id: block.id, name: block.name, input: block.input });
        }
      }
      stream.push({ type: "done", stopReason: message.stopReason, message });
    });
    return stream;
  };
}

export function hangingStream(): StreamFunction {
  return (_model, _context, options) => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );
    if (options.signal) stream.attachSignal(options.signal);
    return stream;
  };
}
