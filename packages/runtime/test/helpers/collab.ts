// @summary Test helpers for collab tests: mock SessionManager and stream factories

import { EventStream } from "@diligent/core/event-stream";
import type { AssistantMessage, Message } from "@diligent/core/message-contract";
import type {
  Model,
  ProviderEvent,
  ProviderResult,
  StreamFunction,
  SystemSection,
} from "@diligent/core/provider-contract";
import type { CollabToolDeps } from "@diligent/runtime/collab";
import type { DiligentPaths } from "@diligent/runtime/infrastructure";
import type { SessionManagerConfig } from "@diligent/runtime/session";
import { getBuiltinAgentDefinitions } from "../../src/agent/agent-types";
import type { AgentEvent } from "../../src/agent-event";
import type { SessionManager } from "../../src/session/manager";

export const TEST_MODEL: Model = {
  modelId: "claude-sonnet-5",
  provider: "anthropic",
  contextWindow: 100_000,
  maxOutputTokens: 4096,
  supportsThinking: false,
};

export const TEST_PATHS: DiligentPaths = {
  root: "/tmp/collab-test",
  sessions: "/tmp/collab-test/.diligent/sessions",
  knowledge: "/tmp/collab-test/.diligent/knowledge",
  skills: "/tmp/collab-test/.diligent/skills",
  images: "/tmp/collab-test/.diligent/images",
};

export function makeAssistant(text = "done"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: TEST_MODEL,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    timestamp: Date.now(),
  };
}

export function makeStreamFn(responses: AssistantMessage[]): StreamFunction {
  let callIndex = 0;
  return (_model, _ctx, _opts) => {
    const msg = responses[callIndex++] ?? makeAssistant();
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (e) => e.type === "done" || e.type === "error",
      (e) => {
        if (e.type === "done") return { message: e.message };
        throw (e as { type: "error"; error: Error }).error;
      },
    );
    queueMicrotask(() => {
      stream.push({ type: "start" });
      stream.push({ type: "text_delta", delta: msg.content[0].type === "text" ? msg.content[0].text : "" });
      stream.push({ type: "done", stopReason: "end_turn", message: msg });
    });
    return stream;
  };
}

export function makeErrorStreamFn(errorMsg = "Provider error"): StreamFunction {
  return (_model, _ctx, _opts) => {
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (e) => e.type === "done" || e.type === "error",
      (e) => {
        if (e.type === "done") return { message: (e as { type: "done"; message: AssistantMessage }).message };
        throw (e as { type: "error"; error: Error }).error;
      },
    );
    queueMicrotask(() => {
      stream.push({ type: "error", error: new Error(errorMsg) });
    });
    return stream;
  };
}

/**
 * Create a controllable mock SessionManager factory.
 * The factory returns mock session managers that produce a fixed EventStream.
 */
let _mockSessionCounter = 0;

export function makeMockSessionManagerFactory(
  response: AssistantMessage | Error,
): CollabToolDeps["sessionManagerFactory"] {
  return (_config: SessionManagerConfig) => {
    const assistantMsg = response instanceof Error ? makeAssistant("error fallback") : response;
    const shouldError = response instanceof Error;
    const errorMsg = response instanceof Error ? response.message : "";
    const mockId = `mock-session-${++_mockSessionCounter}`;
    const listeners = new Set<(event: AgentEvent) => void>();

    return {
      entries: [] as import("../../src/session/types").SessionEntry[],
      leafId: null as string | null,
      create: async () => {},
      resume: async () => false,
      list: async () => [],
      getContext: () => [] as Message[],
      subscribe: (fn: (event: AgentEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      run: async (_userMessage: Message) => {
        const emit = (event: AgentEvent) => {
          for (const fn of listeners) fn(event);
        };
        await new Promise<void>((resolve) => {
          queueMicrotask(() => {
            emit({ type: "agent_start" });
            if (shouldError) {
              emit({
                type: "error",
                error: { message: errorMsg, name: "Error" },
                fatal: true,
              });
            } else {
              const itemId = "mock-item-1";
              emit({ type: "message_start", itemId, message: assistantMsg });
              emit({ type: "message_end", itemId, message: assistantMsg });
            }
            emit({ type: "agent_end", messages: [] });
            resolve();
          });
        });
      },
      waitForWrites: async () => {},
      steer: (_content: string) => {},
      hasPendingMessages: () => false,
      popPendingMessages: () => null,
      appendModeChange: () => {},
      get sessionPath(): string | null {
        return null;
      },
      get sessionId(): string {
        return mockId;
      },
      get entryCount(): number {
        return 0;
      },
    } as unknown as SessionManager;
  };
}

export interface DeferredChildControl {
  started: Promise<void>;
  complete(output: string): void;
}

/** Create child managers whose completion order is controlled explicitly by a test. */
export function makeDeferredSessionManagerFactory(): {
  factory: NonNullable<CollabToolDeps["sessionManagerFactory"]>;
  controls: DeferredChildControl[];
} {
  let counter = 0;
  const controls: DeferredChildControl[] = [];
  const factory: NonNullable<CollabToolDeps["sessionManagerFactory"]> = () => {
    const sessionId = `deferred-session-${++counter}`;
    const listeners = new Set<(event: AgentEvent) => void>();
    let finishRun: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    controls.push({
      started,
      complete(output: string) {
        if (!finishRun) throw new Error(`Deferred child ${sessionId} has not started.`);
        const assistant = makeAssistant(output);
        for (const listener of listeners) {
          listener({ type: "message_start", itemId: `${sessionId}-item`, message: assistant });
          listener({ type: "message_end", itemId: `${sessionId}-item`, message: assistant });
        }
        finishRun();
      },
    });

    return {
      entries: [],
      leafId: null,
      create: async () => {},
      resume: async () => false,
      list: async () => [],
      getContext: () => [],
      subscribe: (listener: (event: AgentEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      run: async () => {
        await new Promise<void>((resolve) => {
          finishRun = resolve;
          markStarted?.();
        });
      },
      waitForWrites: async () => {},
      steer: () => {},
      hasPendingMessages: () => false,
      popPendingMessages: () => null,
      appendModeChange: () => {},
      get sessionPath() {
        return null;
      },
      get sessionId() {
        return sessionId;
      },
      get entryCount() {
        return 0;
      },
    } as unknown as SessionManager;
  };
  return { factory, controls };
}

export function makeCollabDeps(overrides: Partial<CollabToolDeps> = {}): CollabToolDeps {
  return {
    cwd: "/tmp/collab-test",
    paths: TEST_PATHS,
    model: TEST_MODEL,
    effort: "medium",
    systemPrompt: [{ label: "base", content: "You are a helpful agent." }] as SystemSection[],
    agentDefinitions: getBuiltinAgentDefinitions(),
    parentTools: [],
    maxAgents: 8,
    streamFn: makeStreamFn([makeAssistant("default child response")]),
    ...overrides,
  };
}
