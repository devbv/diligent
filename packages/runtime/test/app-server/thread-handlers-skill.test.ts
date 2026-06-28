// @summary Tests slash skill invocation rewrite in thread/turn start handler
import { describe, expect, it } from "bun:test";
import type { DiligentServerNotification } from "@diligent/protocol";
import type { ThreadRuntime } from "@diligent/runtime/app-server/thread-handlers";
import { handleTurnStart } from "@diligent/runtime/app-server/turn-handlers";
import type { DiligentPaths } from "@diligent/runtime/infrastructure";

describe("handleTurnStart slash skill rewriting", () => {
  it("rewrites /skill-name messages into a forced skill-tool instruction", async () => {
    let capturedUserMessage: { content: string | unknown[] } | null = null;

    const runtime: ThreadRuntime = {
      id: "thread-1",
      modelId: "fake-model",
      cwd: "/tmp/project",
      mode: "default",
      effort: "medium",
      manager: {
        subscribe: () => () => {},
        run: async (userMessage: { content: string | unknown[] }) => {
          capturedUserMessage = userMessage;
        },
        getCurrentModel: () => undefined,
        appendModelChange: () => {},
      } as unknown as ThreadRuntime["manager"],
      abortController: null,
      currentTurnId: null,
      isRunning: false,
    };

    const notifications: DiligentServerNotification[] = [];

    await handleTurnStart(
      {
        activeThreadId: "thread-1",
        threads: new Map([["thread-1", runtime]]),
        knownCwds: new Set(["/tmp/project"]),
        resolvePaths: async () =>
          ({
            root: "/tmp/project/.diligent",
            sessions: "/tmp/project/.diligent/sessions",
            knowledge: "/tmp/project/.diligent/knowledge",
            skills: "/tmp/project/.diligent/skills",
            images: "/tmp/project/.diligent/images",
          }) as DiligentPaths,
        createThreadRuntime: async () => runtime,
        resolveThreadRuntime: async () => runtime,
        getLatestEffortForCwd: async () => "medium",
        emit: async (notification) => {
          notifications.push(notification);
        },
        consumeTurn: async () => {},
        resolveToolsContext: async () => ({ cwd: "/tmp/project", tools: undefined }),
        getUserId: () => "test-user",
        getPluginHooks: async () => ({ onUserPromptSubmit: [] }),
        getSkillNames: () => ["tidy-plan"],
        setActiveThreadId: () => {},
      },
      {
        threadId: "thread-1",
        message: "/tidy-plan validate me",
      },
      undefined,
      new Map(),
    );

    expect(capturedUserMessage).not.toBeNull();
    const captured = capturedUserMessage as { content: string | unknown[] } | null;
    expect(typeof captured?.content).toBe("string");
    const text = captured?.content as string;
    expect(text).toContain('call the "skill" tool with {"name":"tidy-plan"}');
    expect(text).toContain("validate me");
    expect(notifications.some((n) => n.method === "agent/event")).toBe(true);
  });

  it("does not rewrite slash commands when name is not an available skill", async () => {
    let capturedUserMessage: { content: string | unknown[] } | null = null;

    const runtime: ThreadRuntime = {
      id: "thread-1",
      modelId: "fake-model",
      cwd: "/tmp/project",
      mode: "default",
      effort: "medium",
      manager: {
        subscribe: () => () => {},
        run: async (userMessage: { content: string | unknown[] }) => {
          capturedUserMessage = userMessage;
        },
        getCurrentModel: () => undefined,
        appendModelChange: () => {},
      } as unknown as ThreadRuntime["manager"],
      abortController: null,
      currentTurnId: null,
      isRunning: false,
    };

    await handleTurnStart(
      {
        activeThreadId: "thread-1",
        threads: new Map([["thread-1", runtime]]),
        knownCwds: new Set(["/tmp/project"]),
        resolvePaths: async () =>
          ({
            root: "/tmp/project/.diligent",
            sessions: "/tmp/project/.diligent/sessions",
            knowledge: "/tmp/project/.diligent/knowledge",
            skills: "/tmp/project/.diligent/skills",
            images: "/tmp/project/.diligent/images",
          }) as DiligentPaths,
        createThreadRuntime: async () => runtime,
        resolveThreadRuntime: async () => runtime,
        getLatestEffortForCwd: async () => "medium",
        emit: async () => {},
        consumeTurn: async () => {},
        resolveToolsContext: async () => ({ cwd: "/tmp/project", tools: undefined }),
        getUserId: () => "test-user",
        getPluginHooks: async () => ({ onUserPromptSubmit: [] }),
        getSkillNames: () => ["tidy-plan"],
        setActiveThreadId: () => {},
      },
      {
        threadId: "thread-1",
        message: "/help",
      },
      undefined,
      new Map(),
    );

    expect(capturedUserMessage).not.toBeNull();
    expect((capturedUserMessage as { content: string | unknown[] } | null)?.content).toBe("/help");
  });
});
