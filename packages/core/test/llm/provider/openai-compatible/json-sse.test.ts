// @summary Transport framing tests for the internal OpenAI-compatible JSON SSE iterator
import { describe, expect, test } from "bun:test";
import { iterateOpenAIJsonSse } from "../../../../src/llm/provider/openai-compatible/json-sse";

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
  options?: Parameters<typeof iterateOpenAIJsonSse>[1],
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const event of iterateOpenAIJsonSse(body, options)) events.push(event);
  return events;
}

describe("iterateOpenAIJsonSse", () => {
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

  test("flushes the decoder and parses a final data line at EOF", async () => {
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
    const iterator = iterateOpenAIJsonSse(body, { signal: controller.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();

    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(cancelled).toBe(true);
  });
});
