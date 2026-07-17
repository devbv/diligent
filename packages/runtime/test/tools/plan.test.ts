// @summary Tests for plan tool: output format, step rendering, empty title default
import { describe, expect, it } from "bun:test";
import type { ToolContext } from "@diligent/core/tool-contract";
import { createPlanTool } from "@diligent/runtime/tools";

function makeCtx(): ToolContext {
  return {
    toolCallId: "test-tc",
    signal: new AbortController().signal,
    abort: () => {},
    onUpdate: () => {},
  };
}

describe("plan tool", () => {
  it("describes plan cleanup on intent changes and deferrals", () => {
    const tool = createPlanTool();

    expect(tool.description).toContain("When user intent changes");
    expect(tool.description).toContain("If the user defers or postpones the work");
    expect(tool.description).toContain("no deferred or abandoned plan still has active pending or in_progress steps");
  });

  it("returns JSON with title and steps", async () => {
    const tool = createPlanTool();
    const result = await tool.execute(
      {
        steps: [
          { text: "Read the code", status: "done" },
          { text: "Write the fix", status: "in_progress" },
          { text: "Run tests", status: "pending" },
        ],
      },
      makeCtx(),
    );

    const parsed = JSON.parse(result.output);
    expect(parsed.title).toBe("Plan");
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[0]).toEqual({ text: "Read the code", status: "done" });
    expect(parsed.steps[1]).toEqual({ text: "Write the fix", status: "in_progress" });
  });

  it("uses custom title when provided", async () => {
    const tool = createPlanTool();
    const result = await tool.execute(
      { title: "Refactor Plan", steps: [{ text: "Step 1", status: "pending" }] },
      makeCtx(),
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.title).toBe("Refactor Plan");
  });

  it("defaults status to pending when omitted", async () => {
    const tool = createPlanTool();
    const input = {
      steps: [{ text: "Do something" }],
    } as unknown as Parameters<typeof tool.execute>[0];
    const result = await tool.execute(input, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.steps[0].status).toBe("pending");
  });

  it("rejects empty steps array", async () => {
    const tool = createPlanTool();
    await expect(tool.execute({ steps: [] }, makeCtx())).rejects.toThrow();
  });

  it("preserves step order", async () => {
    const tool = createPlanTool();
    const steps = [
      { text: "Alpha", status: "pending" as const },
      { text: "Beta", status: "done" as const },
      { text: "Gamma", status: "pending" as const },
    ];
    const result = await tool.execute({ steps }, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.steps.map((s: { text: string }) => s.text)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});
