// @summary ChatGPT JSON adapter tests over standards-compliant SSE framing
import { describe, expect, test } from "bun:test";
import { iterateChatGPTJsonSse } from "../../../../src/llm/provider/chatgpt/http-sse";
import type { ProviderError } from "../../../../src/llm/types";

const encoder = new TextEncoder();

function streamFromByteChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(
  body: ReadableStream<Uint8Array>,
  options?: Parameters<typeof iterateChatGPTJsonSse>[1],
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const event of iterateChatGPTJsonSse(body, options)) events.push(event);
  return events;
}

describe("iterateChatGPTJsonSse", () => {
  test("decodes JSON across byte chunks and CRLF frame boundaries", async () => {
    const bytes = encoder.encode('data: {"text":"before 🙂 after"}\r\n\r\ndata:{"value":2}\r\n\r\n');
    const emojiStart = bytes.indexOf(0xf0);

    const events = await collect(
      streamFromByteChunks([
        bytes.slice(0, emojiStart + 1),
        bytes.slice(emojiStart + 1, emojiStart + 3),
        bytes.slice(emojiStart + 3),
      ]),
    );

    expect(events).toEqual([{ text: "before 🙂 after" }, { value: 2 }]);
  });

  test("joins multi-line data fields and ignores comments", async () => {
    const events = await collect(
      streamFromByteChunks([encoder.encode(': keepalive\ndata: {"multi":\ndata: true}\n\n')]),
    );

    expect(events).toEqual([{ multi: true }]);
  });

  test("flushes a final SSE event at EOF", async () => {
    const events = await collect(streamFromByteChunks([encoder.encode('data: {"final":true}')]));
    expect(events).toEqual([{ final: true }]);
  });

  test("stops at the DONE sentinel", async () => {
    const events = await collect(
      streamFromByteChunks([encoder.encode('data: {"before":1}\n\ndata: [DONE]\n\ndata: {"after":2}\n\n')]),
    );
    expect(events).toEqual([{ before: 1 }]);
  });

  test("skips invalid JSON and reports it without rejecting", async () => {
    const invalid: string[] = [];
    const events = await collect(streamFromByteChunks([encoder.encode('data: {broken}\n\ndata: {"valid":true}\n\n')]), {
      onInvalidJson: (data) => invalid.push(data),
    });
    expect(invalid).toEqual(["{broken}"]);
    expect(events).toEqual([{ valid: true }]);
  });

  test("cancels a pending read when aborted", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const iterator = iterateChatGPTJsonSse(body, { signal: controller.signal, idleTimeoutMs: 50 })[
      Symbol.asyncIterator
    ]();
    const pending = iterator.next();
    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(cancelled).toBe(true);
  });

  test("cancels a stalled body and throws a retryable idle-timeout error", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    const result = collect(body, { idleTimeoutMs: 5, idleTimeoutMessage: "test body idle timeout" });

    await expect(result).rejects.toMatchObject({
      message: "test body idle timeout",
      errorType: "network",
      isRetryable: true,
    } satisfies Partial<ProviderError>);
    expect(cancelled).toBe(true);
  });

  test("resets the idle deadline after each body chunk instead of imposing a total deadline", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.enqueue(encoder.encode('data: {"step":1}\n\n')), 6);
        setTimeout(() => controller.enqueue(encoder.encode('data: {"step":2}\n\n')), 14);
        setTimeout(() => {
          controller.enqueue(encoder.encode('data: {"step":3}\n\n'));
          controller.close();
        }, 22);
      },
    });

    await expect(collect(body, { idleTimeoutMs: 12 })).resolves.toEqual([{ step: 1 }, { step: 2 }, { step: 3 }]);
  });
});
