// @summary ChatGPT HTTP JSON adapter over standards-compliant SSE framing
import { EventSourceParserStream } from "eventsource-parser/stream";

export interface ChatGPTJsonSseOptions {
  signal?: AbortSignal;
  onJson?: (event: Record<string, unknown>, data: string, byteLength: number) => void;
  onInvalidJson?: (data: string, byteLength: number) => void;
}

export async function* iterateChatGPTJsonSse(
  body: ReadableStream<Uint8Array> | null | undefined,
  options: ChatGPTJsonSseOptions = {},
): AsyncIterable<Record<string, unknown>> {
  if (!body || options.signal?.aborted) return;

  const flushFinalEvent = new TransformStream<string, string>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush(controller) {
      controller.enqueue("\n\n");
    },
  });
  const decoder = new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>;
  const events = body.pipeThrough(decoder).pipeThrough(flushFinalEvent).pipeThrough(new EventSourceParserStream());
  const reader = events.getReader();
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
        chunk = await reader.read();
      } catch (error) {
        if (options.signal?.aborted) return;
        throw error;
      }
      if (chunk.done) {
        completed = true;
        return;
      }

      const data = chunk.value.data.trim();
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
  } finally {
    options.signal?.removeEventListener("abort", abortRead);
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
