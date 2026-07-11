// @summary End-to-end tests for the procedural tool surface against a temp .ovdrjm.
//
// Studio is not running in tests, so the level-apply RPC is stubbed; all scene
// mutations still land in the on-disk .ovdrjm via the file utilities.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("../../src/tools/studiorpc/rpc.ts", () => ({
  applyLevelChanges: async () => ({ ok: true }),
  call: async () => ({ ok: true }),
}));

import type { Tool } from "@diligent/core/tool/types";
import { createStudioRpcToolProvider } from "../../src/tools/studiorpc";
import { findNodeByActorGuid, readOvdrjmRoot } from "../../src/tools/studiorpc/tools/ovdrjm-utils";
import { applyProceduralOps } from "../../src/tools/studiorpc/tools/procedural-apply";

const createdDirs: string[] = [];

function cframe(x: number): {
  Position: { X: number; Y: number; Z: number };
  Orientation: { X: number; Y: number; Z: number };
} {
  return { Position: { X: x, Y: 0, Z: 0 }, Orientation: { X: 0, Y: 0, Z: 0 } };
}

function makeProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "procedural-tools-"));
  writeFileSync(join(cwd, "World.umap"), "");
  writeFileSync(
    join(cwd, "World.ovdrjm"),
    JSON.stringify({
      Root: {
        InstanceType: "Workspace",
        ActorGuid: "W",
        Name: "Workspace",
        MapObjectKeyIndex: 10,
        LuaChildren: [
          { InstanceType: "Part", ActorGuid: "pA", Name: "A", CFrame: cframe(0), Size: { X: 1, Y: 1, Z: 1 } },
          { InstanceType: "Part", ActorGuid: "pB", Name: "B", CFrame: cframe(10), Size: { X: 1, Y: 1, Z: 1 } },
        ],
      },
    }),
  );
  createdDirs.push(cwd);
  return cwd;
}

async function loadTools(
  cwd: string,
  approve: () => Promise<"once" | "reject"> = async () => "once",
): Promise<Map<string, Tool>> {
  const provider = createStudioRpcToolProvider();
  const tools = await provider.createTools({ cwd, host: { approve } });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function ctx() {
  return { toolCallId: "test", signal: new AbortController().signal, abort: () => {} };
}

// Mirror the real tool executor: parseArgs runs BEFORE execute and its result is
// what execute receives. Tests must go through this path (not call execute with
// raw args) so regressions like double-parsing are caught.
async function invoke(tool: Tool, rawArgs: Record<string, unknown>) {
  const args = tool.parseArgs ? tool.parseArgs(rawArgs) : rawArgs;
  return tool.execute(args as never, ctx());
}

function workspaceChildren(cwd: string): Array<Record<string, unknown>> {
  const { root } = readOvdrjmRoot(cwd);
  return Array.isArray(root.LuaChildren) ? (root.LuaChildren as Array<Record<string, unknown>>) : [];
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("applyProceduralOps", () => {
  test("applies delete + update + add and reports roots", async () => {
    const cwd = makeProject();
    const result = await applyProceduralOps(
      [
        {
          kind: "add",
          parentGuid: "W",
          node: { class: "Part", name: "C", properties: { Size: { X: 2, Y: 2, Z: 2 } } },
        },
        { kind: "update", guid: "pA", class: "Part", properties: { CFrame: cframe(5) } },
        { kind: "delete", guid: "pB", depth: 1 },
      ],
      { targetGuid: "W", cwd },
    );

    expect(result.addCount).toBe(1);
    expect(result.updateCount).toBe(1);
    expect(result.deleteCount).toBe(1);
    expect(result.rootGuids).toHaveLength(1);

    const { root } = readOvdrjmRoot(cwd);
    expect(findNodeByActorGuid(root, "pB")).toBeUndefined();
    const movedA = findNodeByActorGuid(root, "pA") as Record<string, unknown>;
    expect((movedA.CFrame as { Position: { X: number } }).Position.X).toBe(5);
    const names = workspaceChildren(cwd).map((child) => child.Name);
    expect(names).toContain("C");
    expect(names).not.toContain("B");
  });

  test("skips deletes whose guids are already missing", async () => {
    const cwd = makeProject();
    const result = await applyProceduralOps([{ kind: "delete", guid: "ghost", depth: 1 }], { targetGuid: "W", cwd });
    expect(result.deletedGuids).toEqual([]);
    expect(result.skippedDeletes).toEqual(["ghost"]);
  });
});

describe("studiorpc_procedural_run", () => {
  const moveScript = `-- generationId: move-all
local Move = {}
Move.OnGenerate = function(parameters, targetContainer)
	for _, inst in workspace:GetDescendants() do
		if inst:IsA("BasePart") then
			inst.CFrame += Vector3.xAxis * 1
		end
	end
end
return Move
`;

  test("runs an inline transform and mutates the scene", async () => {
    const cwd = makeProject();
    const tools = await loadTools(cwd);
    const result = await invoke(tools.get("studiorpc_procedural_run")!, { script: moveScript });

    expect(result.metadata).toMatchObject({ method: "procedural.run", updateCount: 2 });
    const { root } = readOvdrjmRoot(cwd);
    expect((findNodeByActorGuid(root, "pA") as { CFrame: { Position: { X: number } } }).CFrame.Position.X).toBe(1);
    expect((findNodeByActorGuid(root, "pB") as { CFrame: { Position: { X: number } } }).CFrame.Position.X).toBe(11);
  });

  test("runs a scriptPath-only file through the parseArgs -> execute path (regression)", async () => {
    // Regression: parseArgs maps scriptPath -> scriptSource; execute must NOT
    // re-parse, or the "exactly one" check sees neither key and throws even for a
    // single valid input.
    const cwd = makeProject();
    writeFileSync(join(cwd, "move.lua"), moveScript);
    const tools = await loadTools(cwd);
    const result = await invoke(tools.get("studiorpc_procedural_run")!, { scriptPath: "move.lua" });
    expect(result.metadata).toMatchObject({ method: "procedural.run", updateCount: 2 });
  });

  test("navigates the scene with FindFirstChild / GetChildren / IsA lookups", async () => {
    const lookupScript = `-- generationId: lookup-nav
local Nav = {}
Nav.OnGenerate = function(parameters, targetContainer)
	-- find by name and update a whitelisted property
	local a = workspace:FindFirstChild("A")
	a.CFrame += Vector3.yAxis * 50
	-- find by name and delete
	workspace:FindFirstChild("B"):Destroy()
	-- GetChildren + FindFirstChildWhichIsA must still resolve after the delete
	assert(#workspace:GetChildren() >= 1, "GetChildren should list remaining children")
	assert(workspace:FindFirstChildWhichIsA("BasePart") ~= nil, "should still find a BasePart")
end
return Nav
`;
    const cwd = makeProject();
    const tools = await loadTools(cwd);
    const result = await invoke(tools.get("studiorpc_procedural_run")!, { script: lookupScript });

    expect(result.metadata).toMatchObject({ method: "procedural.run", updateCount: 1, deleteCount: 1 });
    const { root } = readOvdrjmRoot(cwd);
    expect(findNodeByActorGuid(root, "pB")).toBeUndefined();
    expect((findNodeByActorGuid(root, "pA") as { CFrame: { Position: { Y: number } } }).CFrame.Position.Y).toBe(50);
  });

  test("requires exactly one of script or scriptPath", async () => {
    const cwd = makeProject();
    const tools = await loadTools(cwd);
    const runTool = tools.get("studiorpc_procedural_run")!;
    expect(() => runTool.parameters.parse({})).not.toThrow();
    expect(runTool.parameters.parse({ script: moveScript, maxNodes: 999_999 })).not.toHaveProperty("maxNodes");
    // parseArgs (not the raw schema) enforces the exactly-one rule.
    await expect(invoke(runTool, { script: moveScript, scriptPath: "/x.lua" })).rejects.toThrow(/exactly one/);
    await expect(invoke(runTool, {})).rejects.toThrow(/exactly one/);
  });

  test("rejects before mutating when the user declines", async () => {
    const cwd = makeProject();
    const tools = await loadTools(cwd, async () => "reject");
    const result = await invoke(tools.get("studiorpc_procedural_run")!, { script: moveScript });
    expect(result).toMatchObject({ output: "[Rejected by user]", metadata: { error: true } });
    // scene untouched
    const { root } = readOvdrjmRoot(cwd);
    expect((findNodeByActorGuid(root, "pA") as { CFrame: { Position: { X: number } } }).CFrame.Position.X).toBe(0);
  });
});

describe("procedural model save/list/run", () => {
  const bunnyScript = `-- generationId: bunny-model
local GP = require(script.Dependencies.GeometryPrimitives)
local Bunny = {}
Bunny.OnGenerate = function(parameters, targetContainer)
	local root = GP.model("Bunny", nil)
	GP.sphere("Body", Vector3.new(0, 2, 0), 2, Color3.fromRGB(245, 175, 185), "Plastic", root)
	root.Parent = targetContainer
end
return Bunny
`;

  test("saves, lists, and idempotently re-runs a persisted model", async () => {
    const cwd = makeProject();
    const tools = await loadTools(cwd);

    const saveResult = await invoke(tools.get("studiorpc_procedural_model_save")!, { script: bunnyScript });
    expect(saveResult.metadata).toMatchObject({ method: "procedural.model.save", generationId: "bunny-model" });

    const listResult = await invoke(tools.get("studiorpc_procedural_model_list")!, {});
    expect(listResult.metadata).toMatchObject({ count: 1 });
    expect(listResult.output).toContain("bunny-model");

    const firstRun = await invoke(tools.get("studiorpc_procedural_model_run")!, { id: "bunny-model", targetGuid: "W" });
    expect(firstRun.metadata).toMatchObject({ method: "procedural.model.run" });
    const afterFirst = workspaceChildren(cwd);
    const bunniesAfterFirst = afterFirst.filter((child) => child.Name === "Bunny");
    expect(bunniesAfterFirst).toHaveLength(1);
    expect(afterFirst).toHaveLength(3); // A, B, Bunny

    // Re-run replaces rather than duplicates.
    await invoke(tools.get("studiorpc_procedural_model_run")!, { id: "bunny-model", targetGuid: "W" });
    const afterSecond = workspaceChildren(cwd);
    expect(afterSecond.filter((child) => child.Name === "Bunny")).toHaveLength(1);
    expect(afterSecond).toHaveLength(3);
  });

  test("model_run errors for an unknown id", async () => {
    const cwd = makeProject();
    const tools = await loadTools(cwd);
    await expect(invoke(tools.get("studiorpc_procedural_model_run")!, { id: "nope" })).rejects.toThrow(
      /No saved procedural model/,
    );
  });
});
