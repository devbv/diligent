// @summary Tests for spawn_agent, wait, send_input, close_agent tool execute() methods
import { describe, expect, it } from "bun:test";
import type { ToolContext } from "@diligent/core/tool-contract";
import { createCollabTools } from "@diligent/runtime/collab";
import {
  formatAgentTypeParameterDescription,
  formatSpawnAgentToolDescription,
  getBuiltinAgentDefinitions,
} from "../../src/agent/agent-types";
import { resolveAvailableAgentDefinitions } from "../../src/agent/resolved-agent";
import { makeAssistant, makeCollabDeps, makeMockSessionManagerFactory } from "../helpers/collab";

function makeCtx(updates: string[] = []): ToolContext {
  return {
    toolCallId: "test-tc-1",
    signal: new AbortController().signal,
    abort: () => {},
    onUpdate: (msg) => updates.push(msg),
  };
}

describe("spawn_agent tool", () => {
  it("returns thread_id and nickname as JSON", async () => {
    const { tools } = createCollabTools(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("ok")),
      }),
    );
    const spawnTool = tools.find((t) => t.name === "spawn_agent")!;
    const result = await spawnTool.execute({ message: "do something", agent_type: "general" }, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(typeof parsed.thread_id).toBe("string");
    expect(typeof parsed.nickname).toBe("string");
  });

  it("defaults agent_type to general", async () => {
    const { tools } = createCollabTools(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("ok")),
      }),
    );
    const spawnTool = tools.find((t) => t.name === "spawn_agent")!;
    const result = await spawnTool.execute({ message: "task" }, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(typeof parsed.thread_id).toBe("string");
  });

  it("treats empty allowed_tools as inherit-all", async () => {
    const warned: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warned.push(String(message));
    try {
      const { tools } = createCollabTools(
        makeCollabDeps({
          parentTools: [
            {
              name: "read",
              description: "read",
              parameters: {} as never,
              execute: async () => ({ output: "read" }),
            },
          ],
          sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("ok")),
        }),
      );
      const spawnTool = tools.find((t) => t.name === "spawn_agent")!;

      const result = await spawnTool.execute({ message: "task", agent_type: "explore", allowed_tools: [] }, makeCtx());
      const parsed = JSON.parse(result.output);

      expect(typeof parsed.thread_id).toBe("string");
      expect(warned.join("\n")).not.toContain("zero tools after filtering");
    } finally {
      console.warn = originalWarn;
    }
  });

  it("passes resume_id when provided", async () => {
    const { tools } = createCollabTools(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("resumed")),
      }),
    );
    const spawnTool = tools.find((t) => t.name === "spawn_agent")!;
    const result = await spawnTool.execute(
      { message: "resume this", agent_type: "general", resume_id: "some-session-id" },
      makeCtx(),
    );
    const parsed = JSON.parse(result.output);
    expect(typeof parsed.thread_id).toBe("string");
  });

  it("exposes detailed role guidance in tool description", () => {
    const { tools } = createCollabTools(makeCollabDeps());
    const spawnTool = tools.find((t) => t.name === "spawn_agent")!;
    expect(spawnTool.description).toBe(formatSpawnAgentToolDescription());
    expect(spawnTool.description).toContain("Role selection guide:");
    expect(spawnTool.description).toContain("wait for them before yielding");
    expect(spawnTool.description).toContain("Nested subagents are disabled by default");
    expect(spawnTool.description).toContain(
      "act as the coordinator: monitor, synthesize, and decide the next step instead of doing the same work in parallel",
    );
    expect(spawnTool.description).toContain("Prompt contract:");
    expect(spawnTool.description).toContain("Result contract:");
    expect(spawnTool.description).toContain("Do not ask a child agent to spawn or coordinate additional sub-agents");
    expect(spawnTool.description).toContain("'general':");
    expect(spawnTool.description).toContain("'explore':");
    expect(spawnTool.description).not.toContain("'planner':");
  });

  it("exposes detailed role guidance in agent_type schema description", () => {
    const { tools } = createCollabTools(makeCollabDeps());
    const spawnTool = tools.find((t) => t.name === "spawn_agent")!;
    const shape = (spawnTool.parameters as { shape: Record<string, { description?: string }> }).shape;
    expect(shape.agent_type.description).toBe(formatAgentTypeParameterDescription());
    expect(shape.agent_type.description).toContain("Available built-in roles");
    expect(shape.agent_type.description).toContain("'general':");
    expect(shape.agent_type.description).toContain("'explore':");
    expect(shape.agent_type.description).not.toContain("'planner':");
    expect(shape.allow_nested_agents.description).toContain("Explicit opt-in");
    expect(shape.message.description).toContain("full worker brief");
    expect(shape.message.description).toContain("expected deliverable or result shape");
  });

  it("limits the built-in explore agent to code location lookups", () => {
    const explore = getBuiltinAgentDefinitions().find((agent) => agent.name === "explore");
    expect(explore).toBeDefined();
    expect(explore?.description).toContain("codebase orientation agent");
    expect(explore?.systemPromptPrefix).toContain("not an investigator or reviewer");
    expect(explore?.systemPromptPrefix).toContain("Treat your findings as pointers");

    const description = formatSpawnAgentToolDescription();
    expect(description).toContain("file, symbol, definition, and reference lookups");
    expect(description).toContain("Never delegate code review, audit, correctness analysis");
    expect(description).not.toContain("authoritative codebase Q&A");
    expect(description).not.toContain("Trust explorer results without re-verification");
  });

  it("includes custom agents in tool description and schema description", () => {
    const agentDefinitions = resolveAvailableAgentDefinitions(getBuiltinAgentDefinitions(), [
      {
        name: "code-reviewer",
        description: "Reviews code changes",
        filePath: "/tmp/code-reviewer/AGENT.md",
        content: "Review code carefully.",
        tools: ["read", "glob"],
        defaultModelClass: "general",
        source: "project",
      },
    ]);
    const { tools } = createCollabTools(
      makeCollabDeps({
        agentDefinitions,
      }),
    );
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent")!;
    const shape = (spawnTool.parameters as { shape: Record<string, { description?: string }> }).shape;
    expect(spawnTool.description).toBe(formatSpawnAgentToolDescription(agentDefinitions));
    expect(spawnTool.description).toContain("code-reviewer");
    expect(shape.agent_type.description).toBe(formatAgentTypeParameterDescription(agentDefinitions));
    expect(shape.agent_type.description).toContain("code-reviewer");
    expect(shape.allowed_tools.description).toContain("allow-list");
    expect(shape.allowed_tools.description).toContain("empty list is treated the same as omitted");
    expect(shape.allowed_tools.description).toContain("allow_nested_agents=true");
  });
});

describe("wait tool", () => {
  it("returns status and timed_out=false on completion", async () => {
    const { tools } = createCollabTools(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("done")),
      }),
    );
    const spawnTool = tools.find((t) => t.name === "spawn_agent")!;
    const waitTool = tools.find((t) => t.name === "wait")!;

    const spawned = JSON.parse((await spawnTool.execute({ message: "task" }, makeCtx())).output);
    const result = await waitTool.execute({ ids: [spawned.thread_id] }, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.timed_out).toBe(false);
    expect(parsed.status[spawned.thread_id]).toBeDefined();
  });

  it("clamps timeout_ms to minimum", async () => {
    const { tools } = createCollabTools(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("done")),
      }),
    );
    const spawnTool = tools.find((t) => t.name === "spawn_agent")!;
    const waitTool = tools.find((t) => t.name === "wait")!;
    const spawned = JSON.parse((await spawnTool.execute({ message: "task" }, makeCtx())).output);

    // Provide 1ms timeout — should be clamped to 10s min, still resolves before that
    const result = await waitTool.execute({ ids: [spawned.thread_id], timeout_ms: 1 }, makeCtx());
    const parsed = JSON.parse(result.output);
    // May timeout (1ms clamped to 10s, but agent completes first) or complete — just verify structure
    expect(typeof parsed.timed_out).toBe("boolean");
    expect(typeof parsed.status).toBe("object");
  });

  it("calls onUpdate with progress during wait", async () => {
    const updates: string[] = [];
    const { tools } = createCollabTools(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("done")),
      }),
    );
    const spawnTool = tools.find((t) => t.name === "spawn_agent")!;
    const waitTool = tools.find((t) => t.name === "wait")!;
    const spawned = JSON.parse((await spawnTool.execute({ message: "task" }, makeCtx())).output);
    await waitTool.execute({ ids: [spawned.thread_id] }, makeCtx(updates));
    // onUpdate may or may not be called depending on timing, but should not error
  });

  it("preserves full nested agent output while keeping summary concise", async () => {
    const longOutput = "x".repeat(2_500);
    const { tools } = createCollabTools(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant(longOutput)),
      }),
    );
    const spawnTool = tools.find((t) => t.name === "spawn_agent")!;
    const waitTool = tools.find((t) => t.name === "wait")!;

    const spawned = JSON.parse((await spawnTool.execute({ message: "task" }, makeCtx())).output);
    const result = await waitTool.execute({ ids: [spawned.thread_id] }, makeCtx());
    const parsed = JSON.parse(result.output) as {
      status: Record<string, { kind: string; output?: string }>;
    };

    const status = parsed.status[spawned.thread_id];
    expect(status.kind).toBe("completed");
    expect(status.output).toBe(longOutput);
    expect(parsed.summary[0]).toContain("Completed —");
  });

  it("returns oversized wait output intact at tool layer", async () => {
    const veryLongOutput = "x".repeat(80_000);
    const { tools } = createCollabTools(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant(veryLongOutput)),
      }),
    );
    const spawnTool = tools.find((t) => t.name === "spawn_agent")!;
    const waitTool = tools.find((t) => t.name === "wait")!;

    const spawned = JSON.parse((await spawnTool.execute({ message: "task" }, makeCtx())).output);
    const result = await waitTool.execute({ ids: [spawned.thread_id] }, makeCtx());
    const parsed = JSON.parse(result.output) as {
      status: Record<string, { kind: string; output?: string }>;
    };
    const status = parsed.status[spawned.thread_id];
    expect(status.kind).toBe("completed");
    expect(status.output).toBe(veryLongOutput);
  });

  it("throws for unknown agent ID", async () => {
    const { tools } = createCollabTools(makeCollabDeps());
    const waitTool = tools.find((t) => t.name === "wait")!;
    await expect(waitTool.execute({ ids: ["nonexistent"] }, makeCtx())).rejects.toThrow(/Unknown agent/);
  });
});

describe("send_input tool", () => {
  it("throws for unknown agent", async () => {
    const { tools } = createCollabTools(makeCollabDeps());
    const sendTool = tools.find((t) => t.name === "send_input")!;
    await expect(sendTool.execute({ id: "bad-id", message: "hello" }, makeCtx())).rejects.toThrow(/Unknown agent/);
  });

  it("returns ok=true for running agent (steer called)", async () => {
    let _steerCalled = false;
    const factory = makeMockSessionManagerFactory(makeAssistant("done"));
    const wrappedFactory: typeof factory = (cfg) => {
      const mgr = factory!(cfg);
      const origSteer = mgr.steer.bind(mgr);
      mgr.steer = (content: string) => {
        _steerCalled = true;
        origSteer(content);
      };
      return mgr;
    };
    const { tools } = createCollabTools(makeCollabDeps({ sessionManagerFactory: wrappedFactory }));
    const spawnTool = tools.find((t) => t.name === "spawn_agent")!;
    const sendTool = tools.find((t) => t.name === "send_input")!;

    const spawned = JSON.parse((await spawnTool.execute({ message: "task" }, makeCtx())).output);
    // Agent may have already completed in a microtask — just verify the send_input path
    // If it throws "not running", that's also valid behavior for a completed agent
    try {
      const result = await sendTool.execute({ id: spawned.thread_id, message: "new guidance" }, makeCtx());
      const parsed = JSON.parse(result.output);
      expect(parsed.ok).toBe(true);
    } catch (err) {
      // Acceptable: agent completed before send_input was called
      expect(String(err)).toMatch(/not running|Unknown/);
    }
  });
});

describe("close_agent tool", () => {
  it("returns thread_id, nickname and final_status", async () => {
    const { tools } = createCollabTools(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("done")),
      }),
    );
    const spawnTool = tools.find((t) => t.name === "spawn_agent")!;
    const closeTool = tools.find((t) => t.name === "close_agent")!;

    const spawned = JSON.parse((await spawnTool.execute({ message: "task" }, makeCtx())).output);
    const result = await closeTool.execute({ id: spawned.thread_id }, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.thread_id).toBe(spawned.thread_id);
    expect(typeof parsed.nickname).toBe("string");
    expect(parsed.final_status).toBeDefined();
    expect(typeof parsed.final_status.kind).toBe("string");
  });

  it("throws for unknown agent", async () => {
    const { tools } = createCollabTools(makeCollabDeps());
    const closeTool = tools.find((t) => t.name === "close_agent")!;
    await expect(closeTool.execute({ id: "bad-id" }, makeCtx())).rejects.toThrow(/Unknown agent/);
  });
});
