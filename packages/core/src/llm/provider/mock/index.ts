// @summary Mock StreamFunction factory for tests — eliminates EventStream boilerplate

import { EventStream } from "../../../event-stream";
import type { AssistantMessage } from "../../../types";
import type { ProviderEvent, ProviderResult, StreamFunction } from "../../types";

/** Create a mock StreamFunction that responds with the given message */
export function createMockStream(response: AssistantMessage): StreamFunction {
  return () => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );
    queueMicrotask(() => {
      stream.push({ type: "start" });
      const text = response.content[0]?.type === "text" ? response.content[0].text : "";
      stream.push({ type: "text_delta", delta: text });
      stream.push({ type: "done", stopReason: response.stopReason, message: response });
    });
    return stream;
  };
}
