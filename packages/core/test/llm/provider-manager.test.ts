import { describe, expect, it } from "bun:test";
import { EventStream } from "../../src/event-stream";
import type { NativeCompactionInput } from "../../src/llm/provider/native-compaction";
import { ProviderManager } from "../../src/llm/provider-manager";
import {
  type Model,
  ProviderError,
  type ProviderEvent,
  type ProviderResult,
  type StreamContext,
  type StreamFunction,
  type StreamOptions,
} from "../../src/llm/types";
import type { AssistantMessage } from "../../src/types";

const TEST_MODEL: Model = {
  id: "chatgpt-test",
  provider: "chatgpt",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  supportsThinking: false,
};

const TEST_CONTEXT: StreamContext = {
  systemPrompt: [],
  messages: [],
  tools: [],
};

const TEST_MESSAGE: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  model: TEST_MODEL.id,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  stopReason: "end_turn",
  timestamp: 1,
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function completingStream(onStart: () => void): StreamFunction {
  return () => {
    onStart();
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );
    queueMicrotask(() => {
      stream.push({ type: "start" });
      stream.push({
        type: "done",
        stopReason: "end_turn",
        message: TEST_MESSAGE,
      });
    });
    return stream;
  };
}

async function collectEvents(stream: EventStream<ProviderEvent, ProviderResult>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  await stream.result().catch(() => {});
  return events;
}

describe("ProviderManager auth errors", () => {
  it("throws an auth-typed ProviderError when no credentials are configured", () => {
    const manager = new ProviderManager({});
    const stream = manager.createProxyStream();
    const model = { provider: "anthropic" } as Model;

    // The throw happens synchronously before any stream is built, so context/options are unused.
    try {
      stream(model, {} as StreamContext, {} as StreamOptions);
      throw new Error("expected createProxyStream to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).errorType).toBe("auth");
      expect((err as ProviderError).reason).toBe("credentials_missing");
      expect((err as ProviderError).message).toBe("No authentication is configured for anthropic.");
      expect((err as ProviderError).message).not.toContain("/provider");
    }
  });
});

describe("ProviderManager configuration", () => {
  it("handles API-key set, removal, and empty keys", () => {
    const manager = new ProviderManager({});
    manager.setApiKey("anthropic", "sk-test");
    expect(manager.hasKeyFor("anthropic")).toBe(true);
    expect(manager.getApiKey("anthropic")).toBe("sk-test");

    manager.setApiKey("anthropic", "");
    expect(manager.hasKeyFor("anthropic")).toBe(false);
    manager.removeApiKey("anthropic");
    expect(manager.getApiKey("anthropic")).toBeUndefined();
  });

  it("returns configured providers in stable provider order", () => {
    const manager = new ProviderManager({});
    manager.setApiKey("zai-coding-plan", "zai-key");
    manager.setApiKey("openai", "openai-key");
    manager.setApiKey("anthropic", "anthropic-key");

    expect(manager.getConfiguredProviders()).toEqual(["anthropic", "openai", "zai-coding-plan"]);
  });

  it("reuses cached stream factories and invalidates them by provider", () => {
    const manager = new ProviderManager({});
    const cache = (
      manager as unknown as {
        streamCache: {
          getOrCreate(provider: "openai", apiKey: string): StreamFunction;
          invalidateProvider(provider: "openai"): void;
        };
      }
    ).streamCache;

    const first = cache.getOrCreate("openai", "first-key");
    expect(cache.getOrCreate("openai", "first-key")).toBe(first);
    cache.invalidateProvider("openai");
    expect(cache.getOrCreate("openai", "second-key")).not.toBe(first);
  });

  it("exposes native compaction for API-key providers", () => {
    const manager = new ProviderManager({});
    manager.setApiKey("anthropic", "anthropic-key");
    manager.setApiKey("openai", "openai-key");

    expect(manager.createNativeCompactionForProvider("anthropic")).toBeDefined();
    expect(manager.createNativeCompactionForProvider("openai")).toBeDefined();
    expect(manager.createNativeCompactionForProvider("gemini")).toBeUndefined();
  });

  it("gives configured external auth precedence and falls back after removal", async () => {
    let externalStarts = 0;
    const manager = new ProviderManager({
      auth: {
        chatgpt: {
          isConfigured: () => true,
          getStream: () => completingStream(() => externalStarts++),
        },
      },
    });
    const proxy = manager.createProxyStream();
    await proxy(TEST_MODEL, TEST_CONTEXT, {}).result();
    expect(externalStarts).toBe(1);

    manager.removeExternalAuth("chatgpt");
    expect(manager.hasKeyFor("chatgpt")).toBe(false);
    expect(() => proxy(TEST_MODEL, TEST_CONTEXT, {})).toThrow("No authentication is configured for chatgpt");
  });
});

describe("ProviderManager external auth readiness", () => {
  it("does not start a provider request until readiness resolves and exposes refreshed credentials", async () => {
    const readiness = deferred();
    let credential = "stale";
    const observedCredentials: string[] = [];
    const manager = new ProviderManager({
      auth: {
        chatgpt: {
          isConfigured: () => true,
          ensureFresh: async () => {
            await readiness.promise;
            credential = "fresh";
          },
          getStream: () => completingStream(() => observedCredentials.push(credential)),
        },
      },
    });

    const stream = manager.createProxyStream()(TEST_MODEL, TEST_CONTEXT, {});
    await Promise.resolve();
    expect(observedCredentials).toEqual([]);

    readiness.resolve();
    const events = await collectEvents(stream);

    expect(observedCredentials).toEqual(["fresh"]);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
  });

  it("turns readiness rejection into the terminal stream error", async () => {
    const refreshError = new Error("refresh failed");
    let starts = 0;
    const manager = new ProviderManager({
      auth: {
        chatgpt: {
          isConfigured: () => true,
          ensureFresh: () => Promise.reject(refreshError),
          getStream: () => completingStream(() => starts++),
        },
      },
    });

    const stream = manager.createProxyStream()(TEST_MODEL, TEST_CONTEXT, {});
    const events = await collectEvents(stream);

    expect(starts).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.type === "error" ? events[0].error : undefined).toBe(refreshError);
    await expect(stream.result()).rejects.toBe(refreshError);
  });

  it("prevents the inner stream from starting when aborted before readiness completes", async () => {
    const readiness = deferred();
    const controller = new AbortController();
    let starts = 0;
    const manager = new ProviderManager({
      auth: {
        chatgpt: {
          isConfigured: () => true,
          ensureFresh: () => readiness.promise,
          getStream: () => completingStream(() => starts++),
        },
      },
    });

    const stream = manager.createProxyStream()(TEST_MODEL, TEST_CONTEXT, {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    readiness.resolve();
    await stream.waitForInnerWork();

    expect(starts).toBe(0);
    await expect(stream.result()).rejects.toThrow("Aborted");
  });

  it("leaves concurrent readiness locking to the external binding", async () => {
    const readiness = deferred();
    let refreshWork: Promise<void> | undefined;
    let refreshStarts = 0;
    let streamStarts = 0;
    const manager = new ProviderManager({
      auth: {
        chatgpt: {
          isConfigured: () => true,
          ensureFresh: () => {
            if (!refreshWork) {
              refreshStarts++;
              refreshWork = readiness.promise;
            }
            return refreshWork;
          },
          getStream: () => completingStream(() => streamStarts++),
        },
      },
    });

    const proxy = manager.createProxyStream();
    const first = proxy(TEST_MODEL, TEST_CONTEXT, {});
    const second = proxy(TEST_MODEL, TEST_CONTEXT, {});
    await Promise.resolve();
    expect(refreshStarts).toBe(1);
    expect(streamStarts).toBe(0);

    readiness.resolve();
    await Promise.all([first.result(), second.result()]);
    expect(streamStarts).toBe(2);
  });

  it("awaits readiness before external native compaction", async () => {
    const readiness = deferred();
    let credential = "stale";
    const observedCredentials: string[] = [];
    const manager = new ProviderManager({
      auth: {
        chatgpt: {
          isConfigured: () => true,
          ensureFresh: async () => {
            await readiness.promise;
            credential = "fresh";
          },
          getStream: () => completingStream(() => {}),
          getNativeCompaction: () => async () => {
            observedCredentials.push(credential);
            return { status: "ok", summary: "compacted" };
          },
        },
      },
    });
    const compact = manager.createNativeCompactionForProvider("chatgpt");
    if (!compact) throw new Error("Expected external native compaction");

    const compaction = compact({
      signal: new AbortController().signal,
    } as NativeCompactionInput);
    await Promise.resolve();
    expect(observedCredentials).toEqual([]);

    readiness.resolve();
    await expect(compaction).resolves.toEqual({
      status: "ok",
      summary: "compacted",
    });
    expect(observedCredentials).toEqual(["fresh"]);
  });
});
