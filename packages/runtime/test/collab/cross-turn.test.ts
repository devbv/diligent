// @summary Tests verifying registry reuse across turns and get_agent_status mid-execution polling
import { describe, expect, it } from "bun:test";
import type { ToolContext } from "@diligent/core/tool-contract";
import { createCollabTools } from "@diligent/runtime/collab";
import { makeAssistant, makeCollabDeps, makeMockSessionManagerFactory } from "../helpers/collab";

function makeCtx(): ToolContext {
  return {
    toolCallId: "test-tc",
    signal: new AbortController().signal,
    abort: () => {},
    onUpdate: () => {},
  };
}

describe("cross-turn registry reuse", () => {
  it("existingRegistry reuse: wait in turn 2 sees agent spawned in turn 1", async () => {
    const deps = makeCollabDeps({
      sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("turn-1 result")),
    });

    // ── Turn 1: spawn agent ──
    const { tools: turn1Tools, registry } = createCollabTools(deps);
    const spawnTool = turn1Tools.find((t) => t.name === "spawn_agent")!;
    const spawned = JSON.parse((await spawnTool.execute({ message: "run task" }, makeCtx())).output);
    const { thread_id } = spawned;
    expect(typeof thread_id).toBe("string");

    // ── Turn 2: new createCollabTools call (simulating server.ts per-turn rebuild)
    //    but passing the existing registry — this is the fix we just implemented ──
    const { tools: turn2Tools } = createCollabTools(deps, registry);
    const waitTool = turn2Tools.find((t) => t.name === "wait")!;

    const result = JSON.parse((await waitTool.execute({ ids: [thread_id], timeout_ms: 10000 }, makeCtx())).output);

    expect(result.timed_out).toBe(false);
    const s = result.status[thread_id];
    // Must be completed (not shutdown) because the registry was reused
    expect(s.kind).toBe("completed");
    expect(s.output).toContain("turn-1 result");
  });

  it("existingRegistry: spawn and wait via the same registry survive two tool-set recreations", async () => {
    const deps = makeCollabDeps({
      sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("stable result")),
    });

    const { tools: tools1, registry } = createCollabTools(deps);

    // Spawn in the first tool-set
    const spawn1 = tools1.find((t) => t.name === "spawn_agent")!;
    const { thread_id } = JSON.parse((await spawn1.execute({ message: "work" }, makeCtx())).output);

    // Recreate tools twice (2 turns) with the same registry
    const { tools: _tools2 } = createCollabTools(deps, registry);
    const { tools: tools3 } = createCollabTools(deps, registry);

    const wait3 = tools3.find((t) => t.name === "wait")!;
    const result = JSON.parse((await wait3.execute({ ids: [thread_id] }, makeCtx())).output);

    expect(result.timed_out).toBe(false);
    expect(result.status[thread_id].kind).toBe("completed");
  });
});
