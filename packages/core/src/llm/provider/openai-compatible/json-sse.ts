// @summary Internal JSON-over-SSE framing iterator for OpenAI-compatible HTTP transports

export interface OpenAIJsonSseOptions {
  signal?: AbortSignal;
  onJson?: (event: Record<string, unknown>, data: string, byteLength: number) => void;
  onInvalidJson?: (data: string, byteLength: number) => void;
}

export async function* iterateOpenAIJsonSse(
  body: ReadableStream<Uint8Array> | null | undefined,
  options: OpenAIJsonSseOptions = {},
): AsyncIterable<Record<string, unknown>> {
  if (!body || options.signal?.aborted) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const byteEncoder = new TextEncoder();
  let buffer = "";
  let stopped = false;
  let readerCompleted = false;

  const abortRead = () => {
    void reader.cancel(options.signal?.reason).catch(() => {});
  };
  options.signal?.addEventListener("abort", abortRead, { once: true });

  const parseLine = (rawLine: string): Record<string, unknown> | "done" | undefined => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return undefined;
    const data = line.slice(5).trim();
    if (!data) return undefined;
    if (data === "[DONE]") return "done";
    const byteLength = byteEncoder.encode(data).byteLength;
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      options.onJson?.(event, data, byteLength);
      return event;
    } catch {
      options.onInvalidJson?.(data, byteLength);
      return undefined;
    }
  };

  const drainCompleteLines = (): Array<Record<string, unknown> | "done"> => {
    const parsed: Array<Record<string, unknown> | "done"> = [];
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const value = parseLine(line);
      if (value) parsed.push(value);
      if (value === "done") break;
    }
    return parsed;
  };

  try {
    while (!stopped && !options.signal?.aborted) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (options.signal?.aborted) return;
        throw error;
      }
      if (chunk.done) {
        readerCompleted = true;
        buffer += decoder.decode();
        const finalValues = drainCompleteLines();
        if (buffer) {
          const finalValue = parseLine(buffer);
          if (finalValue) finalValues.push(finalValue);
          buffer = "";
        }
        for (const value of finalValues) {
          if (value === "done") return;
          yield value;
        }
        return;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      for (const value of drainCompleteLines()) {
        if (value === "done") {
          stopped = true;
          break;
        }
        yield value;
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", abortRead);
    if (!readerCompleted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
