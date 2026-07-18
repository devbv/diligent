// @summary Integration: spawn 2 agents, wait for both, verify parallel completion
import { describe, expect, it } from "bun:test";
import type { ToolContext } from "@diligent/core/tool-contract";
import { createCollabTools, isFinal } from "@diligent/runtime/collab";
import { makeAssistant, makeCollabDeps, makeMockSessionManagerFactory } from "../helpers/collab";

function makeCtx(): ToolContext {
  return {
    toolCallId: "test-tc",
    signal: new AbortController().signal,
    abort: () => {},
    onUpdate: () => {},
  };
}

describe("collab integration", () => {
  it("spawn 2 agents → wait → both complete", async () => {
    let callCount = 0;
    const responses = [makeAssistant("agent A output"), makeAssistant("agent B output")];
    const factory = makeMockSessionManagerFactory(responses[0]);
    // Override to return different responses per call
    const multiFactory: typeof factory = (cfg) => {
      const idx = callCount++;
      const resp = responses[idx] ?? responses[responses.length - 1];
      return makeMockSessionManagerFactory(resp)!(cfg);
    };

    const { tools } = createCollabTools(makeCollabDeps({ sessionManagerFactory: multiFactory }));

    const spawnTool = tools.find((t) => t.name === "spawn_agent")!;
    const waitTool = tools.find((t) => t.name === "wait")!;

    const s1 = JSON.parse((await spawnTool.execute({ message: "task A", description: "A" }, makeCtx())).output);
    const s2 = JSON.parse((await spawnTool.execute({ message: "task B", description: "B" }, makeCtx())).output);

    const result = JSON.parse(
      (await waitTool.execute({ ids: [s1.thread_id, s2.thread_id], timeout_ms: 10000 }, makeCtx())).output,
    );
    const { status } = result;

    expect(result.timed_out).toBe(false);
    expect(isFinal(status[s1.thread_id])).toBe(true);
    expect(isFinal(status[s2.thread_id])).toBe(true);
  });

  it("spawn → wait → output captured in status", async () => {
    const { tools } = createCollabTools(
      makeCollabDeps({
        sessionManagerFactory: makeMockSessionManagerFactory(makeAssistant("analysis complete")),
      }),
    );

    const spawnTool = tools.find((t) => t.name === "spawn_agent")!;
    const waitTool = tools.find((t) => t.name === "wait")!;

    const spawned = JSON.parse((await spawnTool.execute({ message: "analyze code" }, makeCtx())).output);
    const { status } = JSON.parse((await waitTool.execute({ ids: [spawned.thread_id] }, makeCtx())).output);

    const s = status[spawned.thread_id];
    expect(s.kind).toBe("completed");
    if (s.kind === "completed") {
      expect(s.output).toContain("analysis complete");
    }
  });

  it("exposes the collab tool protocol contract", () => {
    const { tools } = createCollabTools(makeCollabDeps());
    const names = tools.map((t) => t.name);
    expect(names).toContain("spawn_agent");
    expect(names).toContain("wait");
    expect(names).toContain("send_input");
    expect(names).toContain("close_agent");
  });
});
