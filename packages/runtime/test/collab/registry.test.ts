// @summary Tests for AgentRegistry: spawn, maxAgents, status tracking, shutdownAll
import { describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalImageLoader } from "@diligent/core/image-contract";
import { getDefaultEffortForClass, resolveModel, resolveModelForClass } from "@diligent/core/model-registry";
import type { StreamFunction } from "@diligent/core/provider-contract";
import type { Tool, ToolOutputFileStore } from "@diligent/core/tool-contract";
import type { RuntimeAgent } from "@diligent/runtime/agent/runtime-agent";
import { AgentRegistry, isFinal } from "@diligent/runtime/collab";
import { ensureDiligentDir } from "@diligent/runtime/infrastructure";
import type { SessionManagerConfig } from "@diligent/runtime/session";
import { getBuiltinAgentDefinitions } from "../../src/agent/agent-types";
import { resolveAgentDefinition, resolveAvailableAgentDefinitions } from "../../src/agent/resolved-agent";
import type { AgentEvent } from "../../src/agent-event";
import { resolveChildToolAccess } from "../../src/collab/registry";
import {
  makeAssistant,
  makeCollabDeps,
  makeDeferredSessionManagerFactory,
  makeMockSessionManagerFactory,
  makeStreamFn,
} from "../helpers/collab";

function makeTool(name: string): Tool {
  return {
    name,
    description: name,
    parameters: { safeParse: (value: unknown) => ({ success: true, data: value }) } as never,
    execute: async () => ({ output: name }),
  } as Tool;
}

function makeInspectingSessionManagerFactory(observer: (agent: RuntimeAgent) => void) {
  let counter = 0;
  return (config: SessionManagerConfig) => {
    const sessionId = `inspect-session-${++counter}`;
    const listeners = new Set<(event: AgentEvent) => void>();
    return {
      entries: [],
      leafId: null,
      create: async () => {},
      resume: async () => false,
      list: async () => [],
      getContext: () => [],
      subscribe: (fn: (event: AgentEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      run: async () => {
        const agent = (await config.agent()) as RuntimeAgent;
        observer(agent);
        const assistant = makeAssistant("inspected");
        for (const fn of listeners) {
          fn({ type: "agent_start" });
          fn({ type: "message_start", itemId: "inspect-item", message: assistant });
          fn({ type: "message_end", itemId: "inspect-item", message: assistant });
          fn({ type: "agent_end", messages: [] });
        }
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
    } as never;
  };
}

describe("AgentRegistry", () => {
  it("uses lifecycle-only Stop semantics for child agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-child-stop-lifecycle-"));
    try {
      const paths = await ensureDiligentDir(root);
      let providerCalls = 0;
      let stopCalls = 0;
      let stopInfo: Record<string, unknown> | undefined;
      const baseStream = makeStreamFn([makeAssistant("first"), makeAssistant("legacy rerun")]);
      const streamFn: StreamFunction = (model, context, options) => {
        providerCalls += 1;
        return baseStream(model, context, options);
      };
      const registry = new AgentRegistry(
        makeCollabDeps({
          cwd: root,
          paths,
          streamFn,
          onChildStop: (async (info: Record<string, unknown>) => {
            stopCalls += 1;
            stopInfo = info;
            return stopCalls === 1
              ? {
                  continueWith: {
                    role: "user",
                    content: "legacy child Stop feedback must be ignored",
                    timestamp: Date.now(),
                  },
                }
              : undefined;
          }) as never,
        }),
      );

      const { threadId } = registry.spawn({ prompt: "child task", description: "", agentType: "general" });
      const result = await registry.wait([threadId], 5_000);

      expect(result.status[threadId]?.kind).toBe("completed");
      expect(providerCalls).toBe(1);
      expect(stopCalls).toBe(1);
      expect(stopInfo).not.toHaveProperty("isRerun");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unavailable agent type instead of falling back to general", () => {
    const registry = new AgentRegistry(makeCollabDeps());
    expect(() => registry.spawn({ prompt: "task", description: "", agentType: "experiment-disabled-agent" })).toThrow(
      /Unknown or unavailable agent type/,
    );
  });

  it("spawn returns threadId and nickname immediately", () => {
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("ok")),
      }),
    );
    const { threadId, nickname } = registry.spawn({
      prompt: "do something",
      description: "test agent",
      agentType: "general",
    });
    expect(typeof threadId).toBe("string");
    expect(threadId.length).toBeGreaterThan(0);
    expect(typeof nickname).toBe("string");
    expect(nickname.length).toBeGreaterThan(0);
  });

  it("spawn starts agent as pending/running, not completed", () => {
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("ok")),
      }),
    );
    const { threadId } = registry.spawn({
      prompt: "slow task",
      description: "slow",
      agentType: "general",
    });
    const status = registry.getStatus(threadId);
    // Status may be pending or running immediately after spawn
    expect(status.kind === "pending" || status.kind === "running").toBe(true);
  });

  it("includes cwd in child agent system prompt", async () => {
    let inspectedAgent: RuntimeAgent | undefined;
    const registry = new AgentRegistry(
      makeCollabDeps({
        cwd: "/Users/devbv/git/diligent",
        sessionManagerFactory: makeInspectingSessionManagerFactory((agent) => {
          inspectedAgent = agent;
        }),
      }),
    );

    const { threadId } = registry.spawn({ prompt: "inspect", description: "inspect", agentType: "explore" });
    await registry.wait([threadId], 5000);

    expect(inspectedAgent?.systemPrompt).toContainEqual({
      label: "runtime_context",
      content: "Current working directory: /Users/devbv/git/diligent",
    });
  });

  it("propagates the injected output store through child and nested-child assembly", async () => {
    const outputStore: ToolOutputFileStore = { save: async () => "/tmp/eval-output.txt" };
    let inspectedAgent: RuntimeAgent | undefined;
    const registry = new AgentRegistry(
      makeCollabDeps({
        parentTools: [makeTool("spawn_agent"), makeTool("wait")],
        toolOutputStore: outputStore,
        sessionManagerFactory: makeInspectingSessionManagerFactory((agent) => {
          inspectedAgent = agent;
        }),
      }),
    );

    const { threadId } = registry.spawn({
      prompt: "inspect",
      description: "inspect",
      agentType: "general",
      allowNestedAgents: true,
    });
    await registry.wait([threadId], 5000);

    expect((inspectedAgent as unknown as { toolOutputStore?: ToolOutputFileStore }).toolOutputStore).toBe(outputStore);
    expect(
      (inspectedAgent?.registry as unknown as { deps?: { toolOutputStore?: ToolOutputFileStore } })?.deps
        ?.toolOutputStore,
    ).toBe(outputStore);
  });

  it("wait resolves when agent completes", async () => {
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("finished")),
      }),
    );
    const { threadId } = registry.spawn({
      prompt: "task",
      description: "",
      agentType: "general",
    });
    const { status, timedOut } = await registry.wait([threadId], 5000);
    expect(timedOut).toBe(false);
    expect(status[threadId]).toBeDefined();
    expect(isFinal(status[threadId])).toBe(true);
  });

  it("clears a long wait timer after the agent completes first", async () => {
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    try {
      const registry = new AgentRegistry(
        makeCollabDeps({
          sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("finished")),
        }),
      );
      const { threadId } = registry.spawn({ prompt: "task", description: "", agentType: "general" });
      const callsBeforeWait = clearTimeoutSpy.mock.calls.length;

      const result = await registry.wait([threadId], 900_000);

      expect(result.timedOut).toBe(false);
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsBeforeWait);
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it("wait returns completed status with output", async () => {
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("my output")),
      }),
    );
    const { threadId } = registry.spawn({ prompt: "task", description: "", agentType: "general" });
    const { status } = await registry.wait([threadId], 5000);
    const s = status[threadId];
    expect(s.kind).toBe("completed");
    if (s.kind === "completed") {
      expect(s.output).toContain("my output");
    }
  });

  it("wait has ALL semantics and preserves requested order when children complete in reverse", async () => {
    const events: AgentEvent[] = [];
    const deferred = makeDeferredSessionManagerFactory();
    const registry = new AgentRegistry(
      makeCollabDeps({
        onCollabEvent: (event) => events.push(event),
        sessionManagerFactory: deferred.factory,
      }),
    );
    const first = registry.spawn({ prompt: "first", description: "first", agentType: "general" });
    const second = registry.spawn({ prompt: "second", description: "second", agentType: "general" });
    await Promise.all(deferred.controls.map((control) => control.started));

    let settled = false;
    const waiting = registry.wait([first.threadId, second.threadId], 5_000).then((result) => {
      settled = true;
      return result;
    });
    deferred.controls[1]!.complete("second output");
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    deferred.controls[0]!.complete("first output");
    const result = await waiting;
    expect(result.timedOut).toBe(false);
    expect(Object.keys(result.status)).toEqual([first.threadId, second.threadId]);
    expect(result.status[first.threadId]).toEqual({ kind: "completed", output: "first output" });
    expect(result.status[second.threadId]).toEqual({ kind: "completed", output: "second output" });
    const waitEnd = events.findLast((event) => event.type === "collab_wait_end");
    expect(waitEnd?.type).toBe("collab_wait_end");
    if (waitEnd?.type !== "collab_wait_end") throw new Error("Missing wait_end event.");
    expect(waitEnd.agentStatuses.map((status) => status.threadId)).toEqual([first.threadId, second.threadId]);
  });

  it("keeps a timed-out wait snapshot stable and suppresses its late updates", async () => {
    const deferred = makeDeferredSessionManagerFactory();
    const registry = new AgentRegistry(makeCollabDeps({ sessionManagerFactory: deferred.factory }));
    const child = registry.spawn({ prompt: "late", description: "late", agentType: "general" });
    await deferred.controls[0]!.started;
    const updates: string[] = [];

    const result = await registry.wait([child.threadId], 1, (update) => updates.push(update));
    expect(result.timedOut).toBe(true);
    const returnedSnapshot = structuredClone(result.status);
    const returnedUpdateCount = updates.length;

    deferred.controls[0]!.complete("late output");
    const later = await registry.wait([child.threadId], 1_000);
    expect(later.status[child.threadId]).toEqual({ kind: "completed", output: "late output" });
    expect(result.status).toEqual(returnedSnapshot);
    expect(updates).toHaveLength(returnedUpdateCount);
  });

  it("keeps an aborted wait snapshot stable and suppresses its late updates", async () => {
    const deferred = makeDeferredSessionManagerFactory();
    const registry = new AgentRegistry(makeCollabDeps({ sessionManagerFactory: deferred.factory }));
    const child = registry.spawn({ prompt: "late", description: "late", agentType: "general" });
    await deferred.controls[0]!.started;
    const updates: string[] = [];
    const controller = new AbortController();

    const waiting = registry.wait([child.threadId], 60_000, (update) => updates.push(update), controller.signal);
    controller.abort();
    const result = await waiting;
    expect(result.timedOut).toBe(true);
    const returnedSnapshot = structuredClone(result.status);
    const returnedUpdateCount = updates.length;

    deferred.controls[0]!.complete("late output");
    const later = await registry.wait([child.threadId], 1_000);
    expect(later.status[child.threadId]).toEqual({ kind: "completed", output: "late output" });
    expect(result.status).toEqual(returnedSnapshot);
    expect(updates).toHaveLength(returnedUpdateCount);
  });

  it("emits wait_end when waiting on an already completed agent", async () => {
    const events: AgentEvent[] = [];
    const registry = new AgentRegistry(
      makeCollabDeps({
        onCollabEvent: (event) => events.push(event),
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("already done")),
      }),
    );

    const { threadId } = registry.spawn({ prompt: "task", description: "", agentType: "general" });
    await registry.wait([threadId], 5000);
    events.length = 0;

    const { status, timedOut } = await registry.wait([threadId], 5000);

    expect(timedOut).toBe(false);
    expect(status[threadId]?.kind).toBe("completed");
    expect(
      events.some(
        (event) =>
          event.type === "collab_wait_end" &&
          event.timedOut === false &&
          event.agentStatuses.some((agent) => agent.threadId === threadId && agent.status === "completed"),
      ),
    ).toBe(true);
  });

  it("emits completed spawn_end when child finishes normally", async () => {
    const events: AgentEvent[] = [];
    const registry = new AgentRegistry(
      makeCollabDeps({
        onCollabEvent: (event) => events.push(event),
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("final output")),
      }),
    );

    const { threadId } = registry.spawn({ prompt: "task", description: "", agentType: "general" });
    await registry.wait([threadId], 5000);

    expect(
      events.some(
        (event) =>
          event.type === "collab_spawn_end" &&
          event.childThreadId === threadId &&
          event.status === "completed" &&
          event.message === "final output",
      ),
    ).toBe(true);
  });

  it("rejects spawn when depth is 0", () => {
    const registry = new AgentRegistry(
      makeCollabDeps({
        depth: 0,
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("ok")),
      }),
    );
    expect(() => registry.spawn({ prompt: "task", description: "", agentType: "general" })).toThrow(
      /Max agent nesting depth reached/,
    );
  });

  it("allows spawn when depth is 1 (root spawns one level)", () => {
    const registry = new AgentRegistry(
      makeCollabDeps({
        depth: 1,
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("ok")),
      }),
    );
    const { threadId } = registry.spawn({ prompt: "task", description: "", agentType: "general" });
    expect(registry.getStatus(threadId).kind).toMatch(/pending|running/);
  });

  it("rejects when maxAgents exceeded", () => {
    const registry = new AgentRegistry(
      makeCollabDeps({
        maxAgents: 2,
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("ok")),
      }),
    );
    registry.spawn({ prompt: "task1", description: "", agentType: "general" });
    registry.spawn({ prompt: "task2", description: "", agentType: "general" });
    expect(() => registry.spawn({ prompt: "task3", description: "", agentType: "general" })).toThrow(
      /Max active agents/,
    );
  });

  it("throws for unknown agent ID in wait", async () => {
    const registry = new AgentRegistry(makeCollabDeps());
    await expect(registry.wait(["unknown-id"], 1000)).rejects.toThrow(/Unknown agent/);
  });

  it("getNickname returns undefined for unknown agent", () => {
    const registry = new AgentRegistry(makeCollabDeps());
    expect(registry.getNickname("bad-id")).toBeUndefined();
  });

  it("shutdownAll clears every tracked agent", async () => {
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("done")),
      }),
    );
    const first = registry.spawn({ prompt: "task1", description: "", agentType: "general" });
    const second = registry.spawn({ prompt: "task2", description: "", agentType: "general" });
    await registry.shutdownAll();

    expect(registry.getKnownAgents()).toEqual([]);
    expect(() => registry.getStatus(first.threadId)).toThrow(/Unknown agent/);
    expect(() => registry.getStatus(second.threadId)).toThrow(/Unknown agent/);
  });

  it("close aborts agent and returns final status", async () => {
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("result")),
      }),
    );
    const { threadId } = registry.spawn({ prompt: "task", description: "", agentType: "general" });
    const finalStatus = await registry.close(threadId);
    expect(isFinal(finalStatus)).toBe(true);
    // Agent is retained with shutdown status (not deleted)
    expect(registry.getStatus(threadId)).toEqual({ kind: "shutdown" });
  });

  it("two unique nicknames for two agents", () => {
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("ok")),
      }),
    );
    const r1 = registry.spawn({ prompt: "task1", description: "", agentType: "general" });
    const r2 = registry.spawn({ prompt: "task2", description: "", agentType: "general" });
    expect(r1.nickname).not.toBe(r2.nickname);
  });

  it("restoreAgent registers agent as shutdown", () => {
    const registry = new AgentRegistry(makeCollabDeps());
    registry.restoreAgent("sess-9999", "RestoredBot");
    expect(registry.getNickname("sess-9999")).toBe("RestoredBot");
    expect(registry.getStatus("sess-9999")).toEqual({ kind: "shutdown" });
  });

  it("resumes a known restored child with its historical session id and nickname", async () => {
    const events: AgentEvent[] = [];
    let capturedConfig: SessionManagerConfig | undefined;
    const registry = new AgentRegistry(
      makeCollabDeps({
        onCollabEvent: (event) => events.push(event),
        sessionManagerFactory: (config) => {
          capturedConfig = config;
          const manager = makeMockSessionManagerFactory(makeAssistant("follow-up"))!(config);
          return Object.assign(manager, { resume: async () => true });
        },
      }),
    );
    registry.restoreAgent("sess-historical-1", "RestoredBot");

    const resumed = registry.spawn({
      prompt: "follow up",
      description: "continue",
      agentType: "general",
      resumeId: "sess-historical-1",
    });
    await registry.wait([resumed.threadId], 5000);

    expect(resumed).toEqual({ threadId: "sess-historical-1", nickname: "RestoredBot" });
    expect(capturedConfig?.sessionId).toBe("sess-historical-1");
    expect(registry.getKnownAgents()).toEqual([
      {
        threadId: "sess-historical-1",
        nickname: "RestoredBot",
        description: "continue",
        status: { kind: "completed", output: "follow-up" },
      },
    ]);
    expect(
      events.filter((event) => "childThreadId" in event).every((event) => event.childThreadId === "sess-historical-1"),
    ).toBe(true);
  });

  it("preserves restored child policy and rejects role, model, tool, or nesting escalation", () => {
    let factoryCalls = 0;
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: (config) => {
          factoryCalls++;
          return makeMockSessionManagerFactory(makeAssistant("unexpected"))!(config);
        },
      }),
    );
    registry.restoreAgent("sess-readonly-1", "ReadonlyBot", {
      agentType: "explore",
      modelClass: "lite",
      allowedTools: ["read"],
      allowNestedAgents: false,
    });

    const attempts = [
      { agentType: "general", modelClass: "lite" as const, allowedTools: ["read"], allowNestedAgents: false },
      { agentType: "explore", modelClass: "general" as const, allowedTools: ["read"], allowNestedAgents: false },
      { agentType: "explore", modelClass: "lite" as const, allowedTools: ["read", "edit"], allowNestedAgents: false },
      { agentType: "explore", modelClass: "lite" as const, allowedTools: ["read"], allowNestedAgents: true },
    ];

    for (const policy of attempts) {
      expect(() =>
        registry.spawn({
          prompt: "follow up",
          description: "continue",
          resumeId: "sess-readonly-1",
          ...policy,
        }),
      ).toThrow(/immutable policy/);
    }
    expect(factoryCalls).toBe(0);
  });

  it("applies the immutable restored policy when resume omits policy fields", async () => {
    let inspectedAgent: RuntimeAgent | undefined;
    const events: AgentEvent[] = [];
    const inspectingFactory = makeInspectingSessionManagerFactory((agent) => {
      inspectedAgent = agent;
    });
    const registry = new AgentRegistry(
      makeCollabDeps({
        model: { provider: "openai", modelId: "gpt-5.6-sol" },
        parentTools: [makeTool("read"), makeTool("edit"), makeTool("spawn_agent")],
        onCollabEvent: (event) => events.push(event),
        sessionManagerFactory: (config) =>
          Object.assign(inspectingFactory(config), {
            resume: async () => true,
          }),
      }),
    );
    registry.restoreAgent("sess-readonly-2", "ReadonlyBot", {
      agentType: "explore",
      modelClass: "lite",
      allowedTools: ["read"],
      allowNestedAgents: false,
    });

    const resumed = registry.spawn({
      prompt: "follow up",
      description: "continue",
      resumeId: "sess-readonly-2",
    });
    await registry.wait([resumed.threadId], 5000);

    expect(inspectedAgent?.model.modelId).toBe("gpt-5.6-luna");
    expect(inspectedAgent?.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(inspectedAgent?.systemPrompt).toContainEqual({
      label: "nested_subagent_policy",
      content:
        "Nested sub-agent delegation is disabled for this run. Do not call spawn_agent, wait, send_input, or close_agent, and do not attempt to coordinate additional sub-agents.",
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "collab_spawn_begin", agentType: "explore" }));
  });

  it("does not discard a restored policy when its original agent type is unavailable", () => {
    let factoryCalls = 0;
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: (config) => {
          factoryCalls++;
          return makeMockSessionManagerFactory(makeAssistant("unexpected"))!(config);
        },
      }),
    );
    registry.restoreAgent("sess-retired-role", "RetiredBot", {
      agentType: "retired-readonly-role",
      modelClass: "lite",
      allowedTools: ["read"],
      allowNestedAgents: false,
    });

    expect(() =>
      registry.spawn({
        prompt: "follow up",
        description: "continue",
        resumeId: "sess-retired-role",
      }),
    ).toThrow(/Unknown or unavailable agent type: retired-readonly-role/);
    expect(factoryCalls).toBe(0);
  });

  it("compares an immutable resume tool allowlist as a normalized set", async () => {
    let inspectedAgent: RuntimeAgent | undefined;
    const inspectingFactory = makeInspectingSessionManagerFactory((agent) => {
      inspectedAgent = agent;
    });
    const registry = new AgentRegistry(
      makeCollabDeps({
        parentTools: [makeTool("read"), makeTool("grep"), makeTool("edit")],
        sessionManagerFactory: (config) =>
          Object.assign(inspectingFactory(config), {
            resume: async () => true,
          }),
      }),
    );
    registry.restoreAgent("sess-tool-set", "SetBot", {
      agentType: "explore",
      modelClass: "lite",
      allowedTools: ["read", "grep"],
      allowNestedAgents: false,
    });

    for (const allowedTools of [
      ["read", "grep", "edit"],
      ["read", "edit"],
    ]) {
      expect(() =>
        registry.spawn({
          prompt: "follow up",
          description: "continue",
          resumeId: "sess-tool-set",
          allowedTools,
        }),
      ).toThrow(/immutable policy/);
    }

    const resumed = registry.spawn({
      prompt: "follow up",
      description: "continue",
      resumeId: "sess-tool-set",
      allowedTools: ["grep", "read", "grep"],
    });
    await registry.wait([resumed.threadId], 5000);

    expect(inspectedAgent?.tools.map((tool) => tool.name)).toEqual(["read", "grep"]);
  });

  it("rejects resuming a child that is still active", async () => {
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("finished")),
      }),
    );
    const active = registry.spawn({ prompt: "first task", description: "active", agentType: "general" });

    expect(() =>
      registry.spawn({
        prompt: "overlapping follow-up",
        description: "must not replace active entry",
        agentType: "general",
        resumeId: active.threadId,
      }),
    ).toThrow(/Cannot resume active agent/);

    await registry.wait([active.threadId], 5000);
  });

  it("reports an error instead of creating a replacement when the resumed session is missing", async () => {
    let createCalls = 0;
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: (config) => {
          const manager = makeMockSessionManagerFactory(makeAssistant("must not run"))!(config);
          return Object.assign(manager, {
            create: async () => {
              createCalls++;
            },
            resume: async () => false,
          });
        },
      }),
    );
    registry.restoreAgent("sess-missing-1", "MissingBot");

    const resumed = registry.spawn({
      prompt: "follow up",
      description: "continue",
      agentType: "general",
      resumeId: "sess-missing-1",
    });
    const { status } = await registry.wait([resumed.threadId], 5000);

    expect(status[resumed.threadId]).toEqual({
      kind: "errored",
      error: "Unable to resume agent session: sess-missing-1",
    });
    expect(createCalls).toBe(0);
  });

  it("rejects an unsafe restored resume id before constructing a session manager", () => {
    let factoryCalls = 0;
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: (config) => {
          factoryCalls++;
          return makeMockSessionManagerFactory(makeAssistant("unexpected"))!(config);
        },
      }),
    );
    registry.restoreAgent("../../untrusted", "UnsafeBot");

    expect(() =>
      registry.spawn({
        prompt: "follow up",
        description: "continue",
        agentType: "general",
        resumeId: "../../untrusted",
      }),
    ).toThrow(/Invalid resume target/);
    expect(factoryCalls).toBe(0);
  });

  it("rejects an unknown resume target before constructing a session manager", () => {
    let factoryCalls = 0;
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: (config) => {
          factoryCalls++;
          return makeMockSessionManagerFactory(makeAssistant("unexpected"))!(config);
        },
      }),
    );

    expect(() =>
      registry.spawn({
        prompt: "follow up",
        description: "continue",
        agentType: "general",
        resumeId: "missing-session-1",
      }),
    ).toThrow(/Unknown resume target/);
    expect(factoryCalls).toBe(0);
  });

  it("getKnownAgents reflects final completion after a timed out wait", async () => {
    let resolveRun: (() => void) | null = null;
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: () => {
          const listeners = new Set<(event: AgentEvent) => void>();
          return {
            create: async () => {},
            resume: async () => false,
            list: async () => [],
            getContext: () => [],
            subscribe: (fn: (event: AgentEvent) => void) => {
              listeners.add(fn);
              return () => listeners.delete(fn);
            },
            run: async () => {
              await new Promise<void>((resolve) => {
                resolveRun = () => {
                  const assistant = makeAssistant("late final");
                  for (const fn of listeners) {
                    fn({ type: "message_start", itemId: "late-item", message: assistant });
                    fn({ type: "message_end", itemId: "late-item", message: assistant });
                  }
                  resolve();
                };
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
              return "late-session-1";
            },
            get entryCount() {
              return 0;
            },
          } as never;
        },
      }),
    );

    const { threadId } = registry.spawn({ prompt: "task", description: "", agentType: "general" });
    const firstWait = await registry.wait([threadId], 1);
    expect(firstWait.timedOut).toBe(true);
    expect(firstWait.status[threadId]?.kind === "pending" || firstWait.status[threadId]?.kind === "running").toBe(true);

    resolveRun?.();
    await registry.wait([threadId], 1000);

    expect(registry.getKnownAgents()).toEqual([
      {
        threadId,
        nickname: registry.getNickname(threadId)!,
        description: "",
        status: { kind: "completed", output: "late final" },
      },
    ]);
  });

  it("restoreAgent skips if agent already exists", () => {
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("ok")),
      }),
    );
    const { threadId, nickname } = registry.spawn({ prompt: "task", description: "", agentType: "general" });
    registry.restoreAgent(threadId, "DifferentNick");
    // Original nickname preserved — restore was a no-op
    expect(registry.getNickname(threadId)).toBe(nickname);
  });

  it("restored agents do not count toward maxAgents", () => {
    const registry = new AgentRegistry(
      makeCollabDeps({
        maxAgents: 2,
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("ok")),
      }),
    );
    registry.restoreAgent("sess-old-1", "Old1");
    registry.restoreAgent("sess-old-2", "Old2");
    // Can still spawn 2 active agents despite 2 restored (shutdown) agents
    registry.spawn({ prompt: "task1", description: "", agentType: "general" });
    registry.spawn({ prompt: "task2", description: "", agentType: "general" });
    // 3rd active would exceed limit
    expect(() => registry.spawn({ prompt: "task3", description: "", agentType: "general" })).toThrow(
      /Max active agents/,
    );
  });

  it("spawn passes parentSessionId to child SessionManager config", () => {
    let capturedConfig: SessionManagerConfig | undefined;
    const registry = new AgentRegistry(
      makeCollabDeps({
        getParentSessionId: () => "parent-xyz",
        sessionManagerFactory: (config) => {
          capturedConfig = config;
          return makeMockSessionManagerFactory(makeAssistant("ok"))!(config);
        },
      }),
    );
    registry.spawn({ prompt: "test", description: "", agentType: "general" });
    expect(capturedConfig?.parentSession).toBe("parent-xyz");
  });

  it("emits immediate errored spawn_end when child fails before wait", async () => {
    const events: AgentEvent[] = [];
    const registry = new AgentRegistry(
      makeCollabDeps({
        onCollabEvent: (event) => events.push(event),
        sessionManagerFactory: makeMockSessionManagerFactory(new Error("model not found")),
      }),
    );

    const { threadId } = registry.spawn({ prompt: "task", description: "", agentType: "general" });

    const { status } = await registry.wait([threadId], 5000);
    expect(status[threadId]?.kind).toBe("errored");

    const spawnEndErrored = events.find(
      (event) =>
        event.type === "collab_spawn_end" &&
        event.childThreadId === threadId &&
        event.status === "errored" &&
        event.message?.includes("model not found"),
    );
    expect(spawnEndErrored).toBeDefined();
  });

  it("marks child run exceptions as errored instead of completed with no output", async () => {
    const events: AgentEvent[] = [];
    const registry = new AgentRegistry(
      makeCollabDeps({
        onCollabEvent: (event) => events.push(event),
        sessionManagerFactory: () => {
          const sessionId = "run-throws-session-1";
          const listeners = new Set<(event: AgentEvent) => void>();
          return {
            create: async () => {},
            resume: async () => false,
            list: async () => [],
            getContext: () => [],
            subscribe: (fn: (event: AgentEvent) => void) => {
              listeners.add(fn);
              return () => listeners.delete(fn);
            },
            run: async () => {
              throw new Error("child failed before first message");
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
          } as never;
        },
      }),
    );

    const { threadId } = registry.spawn({ prompt: "task", description: "", agentType: "general" });
    const { status } = await registry.wait([threadId], 5000);

    expect(status[threadId]).toEqual({ kind: "errored", error: "child failed before first message" });
    expect(
      events.some(
        (event) =>
          event.type === "collab_spawn_end" &&
          event.childThreadId === threadId &&
          event.status === "errored" &&
          event.message === "child failed before first message",
      ),
    ).toBe(true);
  });

  it("allows custom agent names to resolve through the shared definition layer", () => {
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("ok")),
        agentDefinitions: resolveAvailableAgentDefinitions(getBuiltinAgentDefinitions(), [
          {
            name: "code-reviewer",
            description: "Reviews code",
            filePath: "/tmp/code-reviewer/AGENT.md",
            content: "Review code carefully.",
            tools: ["read"],
            defaultModelClass: "general",
            source: "project",
          },
        ]),
      }),
    );

    const result = registry.spawn({ prompt: "review", description: "", agentType: "code-reviewer" });
    expect(typeof result.threadId).toBe("string");
  });

  it("uses the built-in agent default model class", async () => {
    const observedModels: string[] = [];
    const parentModelRef = { provider: "anthropic", modelId: "claude-opus-4-8" } as const;
    const exploreDefinition = getBuiltinAgentDefinitions().find((definition) => definition.name === "explore");
    expect(exploreDefinition?.defaultModelClass).toBeDefined();
    const registry = new AgentRegistry(
      makeCollabDeps({
        model: parentModelRef,
        sessionManagerFactory: makeInspectingSessionManagerFactory((agent) => observedModels.push(agent.model.modelId)),
      }),
    );

    const { threadId } = registry.spawn({ prompt: "explore", description: "", agentType: "explore" });
    await registry.wait([threadId], 5000);

    const expected = resolveModelForClass(resolveModel(parentModelRef), exploreDefinition!.defaultModelClass!);
    expect(observedModels).toEqual([expected.modelId]);
  });

  it("uses a custom agent default model class", async () => {
    const observedModels: string[] = [];
    const parentModelRef = { provider: "anthropic", modelId: "claude-opus-4-8" } as const;
    const defaultModelClass = "lite" as const;
    const registry = new AgentRegistry(
      makeCollabDeps({
        model: parentModelRef,
        agentDefinitions: resolveAvailableAgentDefinitions(getBuiltinAgentDefinitions(), [
          {
            name: "quick-reviewer",
            description: "Reviews quickly",
            filePath: "/tmp/quick-reviewer/AGENT.md",
            content: "Review quickly.",
            tools: ["read"],
            defaultModelClass,
            source: "project",
          },
        ]),
        sessionManagerFactory: makeInspectingSessionManagerFactory((agent) => observedModels.push(agent.model.modelId)),
      }),
    );

    const { threadId } = registry.spawn({ prompt: "review", description: "", agentType: "quick-reviewer" });
    await registry.wait([threadId], 5000);

    const expected = resolveModelForClass(resolveModel(parentModelRef), defaultModelClass);
    expect(observedModels).toEqual([expected.modelId]);
  });

  it("inherits the parent model class when an agent has no default", async () => {
    const observedModels: string[] = [];
    const registry = new AgentRegistry(
      makeCollabDeps({
        model: { provider: "anthropic", modelId: "claude-opus-4-8" },
        sessionManagerFactory: makeInspectingSessionManagerFactory((agent) => observedModels.push(agent.model.modelId)),
      }),
    );

    const { threadId } = registry.spawn({ prompt: "work", description: "", agentType: "general" });
    await registry.wait([threadId], 5000);

    expect(observedModels).toEqual(["claude-opus-4-8"]);
  });

  it("excludes collab tools and binds the image loader to the child cwd", async () => {
    let childToolNames: string[] = [];
    let childImageLoader: LocalImageLoader | undefined;
    const childCwd = await mkdtemp(join(tmpdir(), "diligent-child-image-loader-"));
    try {
      await writeFile(join(childCwd, "image.png"), "child-image");
      const registry = new AgentRegistry(
        makeCollabDeps({
          cwd: childCwd,
          parentTools: [makeTool("read"), makeTool("spawn_agent"), makeTool("wait")],
          sessionManagerFactory: makeInspectingSessionManagerFactory((agent) => {
            childToolNames = agent.tools.map((tool) => tool.name);
            childImageLoader = (agent as unknown as { localImageLoader?: LocalImageLoader }).localImageLoader;
          }),
        }),
      );

      const { threadId } = registry.spawn({ prompt: "task", description: "", agentType: "general" });
      await registry.wait([threadId], 5000);
      const bytes = await childImageLoader?.load({ type: "local_image", path: "image.png", mediaType: "image/png" });

      expect(childToolNames).toContain("read");
      expect(childToolNames).not.toContain("spawn_agent");
      expect(childToolNames).not.toContain("wait");
      expect(Buffer.from(bytes!).toString("utf8")).toBe("child-image");
    } finally {
      await rm(childCwd, { recursive: true, force: true });
    }
  });

  it("treats an empty per-spawn allowedTools list as inherit-all", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let childToolNames: string[] = [];
      const registry = new AgentRegistry(
        makeCollabDeps({
          parentTools: [makeTool("read"), makeTool("grep"), makeTool("spawn_agent")],
          sessionManagerFactory: makeInspectingSessionManagerFactory((agent) => {
            childToolNames = agent.tools.map((tool) => tool.name);
          }),
        }),
      );

      const { threadId } = registry.spawn({
        prompt: "task",
        description: "",
        agentType: "explore",
        allowedTools: [],
      });
      await registry.wait([threadId], 5000);

      const warning = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(warning).not.toContain("zero tools after filtering");
      expect(childToolNames).toContain("read");
      expect(childToolNames).toContain("grep");
      expect(childToolNames).not.toContain("spawn_agent");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs zero-tool diagnostics with each filtering step", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new AgentRegistry(
        makeCollabDeps({
          parentTools: [makeTool("read"), makeTool("grep"), makeTool("spawn_agent")],
          sessionManagerFactory: makeInspectingSessionManagerFactory(() => {}),
        }),
      );

      const { threadId } = registry.spawn({
        prompt: "task",
        description: "",
        agentType: "explore",
        allowedTools: ["missing_tool"],
      });
      await registry.wait([threadId], 5000);

      const warning = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(warning).toContain("with zero tools after filtering");
      expect(warning).toContain("Parent tools: [read, grep, spawn_agent]");
      expect(warning).toContain("Agent definition: name=explore, readonly=true, allowedTools=[(inherit all)]");
      expect(warning).toContain("Spawn params: allowNestedAgents=false, allowedTools=[missing_tool]");
      expect(warning).toContain("after nested-collab exclusion: kept [read, grep], removed [spawn_agent]");
      expect(warning).toContain("after spawn allowedTools allow-list: kept [(none)], removed [read, grep]");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("allows collab tools only when nested agents are explicitly enabled", async () => {
    let childToolNames: string[] = [];
    const registry = new AgentRegistry(
      makeCollabDeps({
        parentTools: [makeTool("read"), makeTool("spawn_agent"), makeTool("wait")],
        sessionManagerFactory: makeInspectingSessionManagerFactory((agent) => {
          childToolNames = agent.tools.map((tool) => tool.name);
        }),
      }),
    );

    const { threadId } = registry.spawn({
      prompt: "task",
      description: "",
      agentType: "general",
      allowNestedAgents: true,
      allowedTools: ["read", "spawn_agent"],
    });
    await registry.wait([threadId], 5000);

    expect(childToolNames).toContain("read");
    expect(childToolNames).toContain("spawn_agent");
    expect(childToolNames).not.toContain("wait");
  });

  it("injects an explicit nested-subagent policy into the child system prompt", async () => {
    let systemSections: Array<{ label: string; content: string }> = [];
    const registry = new AgentRegistry(
      makeCollabDeps({
        sessionManagerFactory: makeInspectingSessionManagerFactory((agent) => {
          systemSections = agent.systemPrompt.map((section) => ({ label: section.label, content: section.content }));
        }),
      }),
    );

    const { threadId } = registry.spawn({ prompt: "task", description: "", agentType: "general" });
    await registry.wait([threadId], 5000);

    const policy = systemSections.find((section) => section.label === "nested_subagent_policy");
    expect(policy?.content).toContain("Nested sub-agent delegation is disabled");
    expect(policy?.content).toContain("Do not call spawn_agent, wait, send_input, or close_agent");
  });

  it("uses the model-class policy effort for an explicit child class", async () => {
    const observedEfforts: string[] = [];
    const modelClass = "lite" as const;
    const registry = new AgentRegistry(
      makeCollabDeps({
        effort: "max",
        sessionManagerFactory: makeInspectingSessionManagerFactory((agent) => {
          observedEfforts.push(agent.effort);
        }),
      }),
    );

    const child = registry.spawn({ prompt: "task", description: "", agentType: "general", modelClass });
    await registry.wait([child.threadId], 5000);

    expect(observedEfforts).toEqual([getDefaultEffortForClass(modelClass)]);
  });

  it("updates reused registry deps so later child spawns see the latest parent model", async () => {
    const observedModels: string[] = [];
    const observedEfforts: string[] = [];
    const initialModel = { provider: "anthropic", modelId: "claude-opus-4-8" } as const;
    const latestModel = { provider: "openai", modelId: "gpt-5.6-sol" } as const;
    const latestEffort = "high" as const;
    const registry = new AgentRegistry(
      makeCollabDeps({
        model: initialModel,
        effort: "medium",
        sessionManagerFactory: makeInspectingSessionManagerFactory((agent) => {
          observedModels.push(agent.model.modelId);
          observedEfforts.push(agent.effort);
        }),
      }),
    );

    registry.updateDeps(makeCollabDeps({ model: latestModel, effort: latestEffort }));

    const { threadId } = registry.spawn({ prompt: "task", description: "", agentType: "general" });
    await registry.wait([threadId], 5000);

    expect(observedModels).toEqual([latestModel.modelId]);
    expect(observedEfforts).toEqual([latestEffort]);
  });

  it("creates distinct bundled loop-hook instances for each child with child context", async () => {
    const instances: object[] = [];
    const kinds: string[] = [];
    const registry = new AgentRegistry(
      makeCollabDeps({
        agentLoopHookFactories: [
          (context) => {
            kinds.push(context.agentKind);
            const hook = { id: `child-${instances.length}` };
            instances.push(hook);
            return [hook];
          },
        ],
        sessionManagerFactory: makeInspectingSessionManagerFactory(() => {}),
      }),
    );

    const first = registry.spawn({ prompt: "one", description: "", agentType: "general" });
    const second = registry.spawn({ prompt: "two", description: "", agentType: "general" });
    await registry.wait([first.threadId, second.threadId], 5000);

    expect(kinds).toEqual(["child", "child"]);
    expect(instances).toHaveLength(2);
    expect(instances[0]).not.toBe(instances[1]);
  });

  it("lets main-only loop-hook factories opt out of child agents", async () => {
    let createdHooks = 0;
    const registry = new AgentRegistry(
      makeCollabDeps({
        agentLoopHookFactories: [
          (context) => {
            if (context.agentKind !== "main") return [];
            createdHooks++;
            return [{ id: "main-only" }];
          },
        ],
        sessionManagerFactory: makeInspectingSessionManagerFactory(() => {}),
      }),
    );
    const child = registry.spawn({ prompt: "one", description: "", agentType: "general" });
    await registry.wait([child.threadId], 5000);
    expect(createdHooks).toBe(0);
  });
});

// ─── resolveChildToolAccess (pure function) edge-case tests ────────────────────

describe("resolveChildToolAccess", () => {
  it("readonly (plan-mode) agent definition excludes write tools from child", () => {
    const parentTools = [makeTool("read"), makeTool("bash"), makeTool("edit"), makeTool("grep")];
    const agentDef = resolveAgentDefinition(getBuiltinAgentDefinitions(), "explore");
    if (!agentDef) throw new Error("explore agent definition not found");

    const { childTools } = resolveChildToolAccess(parentTools, {}, agentDef);

    const names = childTools.map((tool) => tool.name);
    expect(names).toContain("read");
    expect(names).toContain("grep");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("edit");
  });

  it("collab tools excluded from childTools even when allowNestedAgents=true", () => {
    const parentTools = [makeTool("read"), makeTool("spawn_agent"), makeTool("wait")];
    const agentDef = resolveAgentDefinition(getBuiltinAgentDefinitions(), "general");
    if (!agentDef) throw new Error("general agent definition not found");

    const { childTools, nestedCollabEnabled } = resolveChildToolAccess(
      parentTools,
      { allowNestedAgents: true },
      agentDef,
    );

    expect(nestedCollabEnabled).toBe(true);
    const names = childTools.map((tool) => tool.name);
    expect(names).toContain("read");
    expect(names).not.toContain("spawn_agent");
    expect(names).not.toContain("wait");
  });

  it("nestedCollabEnabled=false when allowNestedAgents is not set", () => {
    const parentTools = [makeTool("read"), makeTool("spawn_agent"), makeTool("wait")];
    const agentDef = resolveAgentDefinition(getBuiltinAgentDefinitions(), "general");
    if (!agentDef) throw new Error("general agent definition not found");

    const { nestedCollabEnabled, childTools } = resolveChildToolAccess(parentTools, {}, agentDef);

    expect(nestedCollabEnabled).toBe(false);
    expect(childTools.map((tool) => tool.name)).toContain("read");
    expect(childTools.map((tool) => tool.name)).not.toContain("spawn_agent");
  });

  it("per-spawn allowedTools list intersects with parent tools after mode filtering", () => {
    const parentTools = [makeTool("read"), makeTool("bash"), makeTool("grep"), makeTool("edit")];
    const agentDef = resolveAgentDefinition(getBuiltinAgentDefinitions(), "general");
    if (!agentDef) throw new Error("general agent definition not found");

    const { childTools } = resolveChildToolAccess(parentTools, { allowedTools: ["read", "bash"] }, agentDef);

    const names = childTools.map((tool) => tool.name);
    expect(names).toContain("read");
    expect(names).toContain("bash");
    expect(names).not.toContain("grep");
    expect(names).not.toContain("edit");
  });
});

// ─── Tool filtering integration edge-case tests ────────────────────────────────

describe("AgentRegistry tool filtering edge cases", () => {
  it("spawn with readonly agent type (explore) excludes plan-mode write tools from child", async () => {
    let childToolNames: string[] = [];
    const registry = new AgentRegistry(
      makeCollabDeps({
        parentTools: [makeTool("read"), makeTool("bash"), makeTool("edit"), makeTool("grep")],
        sessionManagerFactory: makeInspectingSessionManagerFactory((agent) => {
          childToolNames = agent.tools.map((tool) => tool.name);
        }),
      }),
    );

    const { threadId } = registry.spawn({ prompt: "read-only survey", description: "", agentType: "explore" });
    await registry.wait([threadId], 5000);

    expect(childToolNames).toContain("read");
    expect(childToolNames).toContain("grep");
    expect(childToolNames).not.toContain("bash");
    expect(childToolNames).not.toContain("edit");
  });

  it("mode change via updateDeps propagates to subsequently spawned child tool sets", async () => {
    const toolSetsObserved: string[][] = [];
    const registry = new AgentRegistry(
      makeCollabDeps({
        parentTools: [makeTool("read"), makeTool("bash"), makeTool("grep")],
        sessionManagerFactory: makeInspectingSessionManagerFactory((agent) => {
          toolSetsObserved.push(agent.tools.map((tool) => tool.name));
        }),
      }),
    );

    const t1 = registry.spawn({ prompt: "task1", description: "", agentType: "general" });
    await registry.wait([t1.threadId], 5000);

    registry.updateDeps(
      makeCollabDeps({
        parentTools: [makeTool("read"), makeTool("grep")],
      }),
    );

    const t2 = registry.spawn({ prompt: "task2", description: "", agentType: "general" });
    await registry.wait([t2.threadId], 5000);

    expect(toolSetsObserved[0]).toContain("bash");
    expect(toolSetsObserved[1]).not.toContain("bash");
    expect(toolSetsObserved[1]).toContain("read");
    expect(toolSetsObserved[1]).toContain("grep");
  });

  it("parent collab tool instances never appear in childTools; allowedTools limits which fresh collab tools are injected", async () => {
    let childToolNames: string[] = [];
    const registry = new AgentRegistry(
      makeCollabDeps({
        parentTools: [makeTool("read"), makeTool("spawn_agent"), makeTool("wait"), makeTool("close_agent")],
        sessionManagerFactory: makeInspectingSessionManagerFactory((agent) => {
          childToolNames = agent.tools.map((tool) => tool.name);
        }),
      }),
    );

    // allowNestedAgents=true but allowedTools restricts to read + spawn_agent only.
    // The parent's wait and close_agent instances must not appear in the child;
    // buildDefaultTools creates fresh collab tools but they are filtered to only spawn_agent.
    const { threadId } = registry.spawn({
      prompt: "task",
      description: "",
      agentType: "general",
      allowNestedAgents: true,
      allowedTools: ["read", "spawn_agent"],
    });
    await registry.wait([threadId], 5000);

    expect(childToolNames).toContain("read");
    expect(childToolNames).toContain("spawn_agent");
    expect(childToolNames).not.toContain("wait");
    expect(childToolNames).not.toContain("close_agent");
  });

  it("zero-tool diagnostic fires when parent has only collab tools and nesting is disabled", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new AgentRegistry(
        makeCollabDeps({
          parentTools: [makeTool("spawn_agent"), makeTool("wait"), makeTool("close_agent")],
          sessionManagerFactory: makeInspectingSessionManagerFactory(() => {}),
        }),
      );

      const { threadId } = registry.spawn({ prompt: "task", description: "", agentType: "general" });
      await registry.wait([threadId], 5000);

      const warning = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(warning).toContain("with zero tools after filtering");
      expect(warning).toContain("after nested-collab exclusion");
      expect(warning).toContain("kept [(none)]");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
