// @summary ChatGPT HTTP JSON adapter over standards-compliant SSE framing
import { createParser } from "eventsource-parser";
import { waitForOpenAIStreamProgress } from "../openai/shared";

export interface ChatGPTJsonSseOptions {
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  idleTimeoutMessage?: string;
  onJson?: (event: Record<string, unknown>, data: string, byteLength: number) => void;
  onInvalidJson?: (data: string, byteLength: number) => void;
}

export async function* iterateChatGPTJsonSse(
  body: ReadableStream<Uint8Array> | null | undefined,
  options: ChatGPTJsonSseOptions = {},
): AsyncIterable<Record<string, unknown>> {
  if (!body || options.signal?.aborted) return;

  const pendingEvents: string[] = [];
  const parser = createParser({
    onEvent(event) {
      pendingEvents.push(event.data);
    },
  });
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const encoder = new TextEncoder();
  let completed = false;
  const abortRead = () => {
    void reader.cancel(options.signal?.reason).catch(() => {});
  };
  options.signal?.addEventListener("abort", abortRead, { once: true });

  try {
    while (!options.signal?.aborted) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        const read = reader.read();
        chunk =
          options.idleTimeoutMs === undefined
            ? await read
            : await waitForOpenAIStreamProgress(read, {
                idleTimeoutMs: options.idleTimeoutMs,
                message:
                  options.idleTimeoutMessage ?? `ChatGPT HTTP stream idle timeout after ${options.idleTimeoutMs}ms`,
                signal: options.signal,
                onTimeout: (error) => reader.cancel(error),
                onAbort: (reason) => reader.cancel(reason),
              });
      } catch (error) {
        if (options.signal?.aborted) return;
        throw error;
      }
      if (chunk.done) {
        parser.feed(decoder.decode());
        parser.feed("\n\n");
        completed = true;
      } else {
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }

      while (pendingEvents.length > 0) {
        const data = pendingEvents.shift()?.trim() ?? "";
        if (!data) continue;
        if (data === "[DONE]") return;
        const byteLength = encoder.encode(data).byteLength;
        try {
          const event = JSON.parse(data) as Record<string, unknown>;
          options.onJson?.(event, data, byteLength);
          yield event;
        } catch {
          options.onInvalidJson?.(data, byteLength);
        }
      }
      if (completed) return;
    }
  } finally {
    options.signal?.removeEventListener("abort", abortRead);
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
