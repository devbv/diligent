// @summary End-to-end tests for the procedural tool surface against a temp .ovdrjm.
//
// Studio is not running in tests, so the level-apply RPC is stubbed; all scene
// mutations still land in the on-disk .ovdrjm via the file utilities.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let applyLevelChangesCalls = 0;
mock.module("../../src/tools/studiorpc/rpc.ts", () => ({
  applyLevelChanges: async () => {
    applyLevelChangesCalls += 1;
    return { ok: true };
  },
  call: async () => ({ ok: true }),
}));

import type { Tool } from "@diligent/core/tool/types";
import { runProceduralScript } from "../../src/procedural";
import { createStudioRpcToolProvider } from "../../src/tools/studiorpc";
import { findNodeByActorGuid, readOvdrjmRoot } from "../../src/tools/studiorpc/tools/ovdrjm-utils";
import { applyProceduralOps } from "../../src/tools/studiorpc/tools/procedural-apply";
import { readProceduralScene } from "../../src/tools/studiorpc/tools/procedural-scene";

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

function makeReparentProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "procedural-reparent-"));
  writeFileSync(join(cwd, "World.umap"), "");
  writeFileSync(
    join(cwd, "World.ovdrjm"),
    JSON.stringify({
      Root: {
        InstanceType: "Workspace",
        ActorGuid: "W",
        Name: "Workspace",
        LuaChildren: [
          {
            InstanceType: "Folder",
            ActorGuid: "left",
            Name: "Left",
            LuaChildren: [{ InstanceType: "Part", ActorGuid: "child", Name: "Child", Size: { X: 1, Y: 1, Z: 1 } }],
          },
          { InstanceType: "Folder", ActorGuid: "right", Name: "Right", LuaChildren: [] },
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

// procedural_run reads reusable recipes from the canonical project-local path.
let scriptSeq = 0;
function writeRecipe(cwd: string, id: string, source: string): string {
  const recipeDir = join(cwd, ".overdare", "procedural", id);
  mkdirSync(recipeDir, { recursive: true });
  const scriptPath = join(recipeDir, "main.lua");
  writeFileSync(scriptPath, source);
  return scriptPath;
}

function invokeRun(tools: Map<string, Tool>, cwd: string, source: string, id = `procedural-run-${scriptSeq++}`) {
  writeRecipe(cwd, id, source);
  return invoke(tools.get("studiorpc_procedural_run")!, { id });
}

function workspaceChildren(cwd: string): Array<Record<string, unknown>> {
  const { root } = readOvdrjmRoot(cwd);
  return Array.isArray(root.LuaChildren) ? (root.LuaChildren as Array<Record<string, unknown>>) : [];
}

afterEach(() => {
  applyLevelChangesCalls = 0;
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
          localId: "part-c",
          parent: { kind: "existing", guid: "W" },
          class: "Part",
          name: "C",
          properties: { Size: { X: 2, Y: 2, Z: 2 } },
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

  test("normalizes explicit descendant Mobility after applying procedural JSON", async () => {
    const cwd = makeProject();
    const result = await applyProceduralOps(
      [
        {
          kind: "add",
          localId: "hello",
          parent: { kind: "existing", guid: "W" },
          class: "Folder",
          name: "hello",
          properties: { Mobility: "Static" },
        },
        {
          kind: "add",
          localId: "hey",
          parent: { kind: "generated", localId: "hello" },
          class: "Model",
          name: "hey",
          properties: { Mobility: "Movable" },
        },
        {
          kind: "add",
          localId: "k",
          parent: { kind: "generated", localId: "hey" },
          class: "Part",
          name: "k",
          properties: {},
        },
      ],
      { targetGuid: "W", cwd },
    );

    const root = readOvdrjmRoot(cwd).root;
    const hello = findNodeByActorGuid(root, result.addedGuids[0]) as Record<string, unknown>;
    const hey = findNodeByActorGuid(root, result.addedGuids[1]) as Record<string, unknown>;
    const k = findNodeByActorGuid(root, result.addedGuids[2]) as Record<string, unknown>;
    expect(hello.Mobility).toBe("Static");
    expect(hey.Mobility).toBe("Static");
    expect("Mobility" in k).toBe(false);
  });

  test("validates every operation before mutating the level", async () => {
    const cwd = makeProject();

    await expect(
      applyProceduralOps(
        [
          { kind: "delete", guid: "pB", depth: 1 },
          { kind: "update", guid: "pA", class: "Part", properties: { Text: "not a Part property" } },
        ],
        { targetGuid: "W", cwd },
      ),
    ).rejects.toThrow(/class=Part/);

    expect(findNodeByActorGuid(readOvdrjmRoot(cwd).root, "pB")).toBeDefined();
  });

  test("rejects hierarchy cycles before mutating the level", async () => {
    const cwd = makeReparentProject();

    await expect(
      applyProceduralOps([{ kind: "move", guid: "left", parent: { kind: "existing", guid: "child" } }], {
        targetGuid: "W",
        cwd,
      }),
    ).rejects.toThrow(/cycle|descendant/i);

    expect(workspaceChildren(cwd).map((child) => child.Name)).toContain("Left");
  });

  test("moves an existing subtree below a generated parent without changing its guid", async () => {
    const cwd = makeReparentProject();
    const result = await applyProceduralOps(
      [
        {
          kind: "add",
          localId: "generated-folder",
          parent: { kind: "existing", guid: "W" },
          class: "Folder",
          name: "GeneratedFolder",
          properties: {},
        },
        { kind: "move", guid: "child", parent: { kind: "generated", localId: "generated-folder" } },
      ],
      { targetGuid: "W", cwd },
    );

    expect(result).toMatchObject({ addCount: 1, moveCount: 1, movedGuids: ["child"] });
    expect(applyLevelChangesCalls).toBe(1);
    const root = readOvdrjmRoot(cwd).root;
    const child = findNodeByActorGuid(root, "child") as Record<string, unknown>;
    const folder = workspaceChildren(cwd).find((node) => node.Name === "GeneratedFolder")!;
    expect(child).toMatchObject({ ActorGuid: "child", Name: "Child", Size: { X: 1, Y: 1, Z: 1 } });
    expect((folder.LuaChildren as Array<Record<string, unknown>>).map((node) => node.ActorGuid)).toEqual(["child"]);
    expect(result.rootGuids).toEqual([String(folder.ActorGuid)]);
  });

  test("resolves nested generated parents and mixed fresh/existing siblings", async () => {
    const cwd = makeProject();
    const result = await applyProceduralOps(
      [
        {
          kind: "add",
          localId: "outer",
          parent: { kind: "existing", guid: "W" },
          class: "Folder",
          name: "Outer",
          properties: {},
        },
        {
          kind: "add",
          localId: "inner",
          parent: { kind: "generated", localId: "outer" },
          class: "Folder",
          name: "Inner",
          properties: {},
        },
        {
          kind: "add",
          localId: "fresh-leaf",
          parent: { kind: "generated", localId: "inner" },
          class: "Part",
          name: "FreshLeaf",
          properties: { Size: { X: 2, Y: 2, Z: 2 } },
        },
        { kind: "move", guid: "pA", parent: { kind: "generated", localId: "inner" } },
      ],
      { targetGuid: "W", cwd },
    );

    expect(result).toMatchObject({ addCount: 3, moveCount: 1, movedGuids: ["pA"] });
    const root = readOvdrjmRoot(cwd).root;
    const outer = workspaceChildren(cwd).find((node) => node.Name === "Outer")!;
    const inner = (outer.LuaChildren as Array<Record<string, unknown>>).find((node) => node.Name === "Inner")!;
    expect((inner.LuaChildren as Array<Record<string, unknown>>).map((node) => node.Name)).toEqual(["FreshLeaf", "A"]);
    expect(findNodeByActorGuid(root, "pA")).toBeDefined();
    expect(result.rootGuids).toEqual([String(outer.ActorGuid)]);
  });

  test("moves a child out before deleting its old parent", async () => {
    const cwd = makeReparentProject();
    const result = await applyProceduralOps(
      [
        { kind: "move", guid: "child", parent: { kind: "existing", guid: "right" } },
        { kind: "delete", guid: "left", depth: 1 },
      ],
      { targetGuid: "W", cwd },
    );

    expect(result).toMatchObject({ movedGuids: ["child"], deletedGuids: ["left"] });
    const root = readOvdrjmRoot(cwd).root;
    expect(findNodeByActorGuid(root, "child")).toBeDefined();
    expect(findNodeByActorGuid(root, "left")).toBeUndefined();
  });

  test("applies more than 100 generated nodes in the single document transaction", async () => {
    const cwd = makeProject();
    const ops = Array.from({ length: 101 }, (_, index) => ({
      kind: "add" as const,
      localId: `folder-${index}`,
      parent: { kind: "existing" as const, guid: "W" },
      class: "Folder",
      name: `Folder_${index}`,
      properties: {},
    }));

    const result = await applyProceduralOps(ops, { targetGuid: "W", cwd });
    expect(result.addCount).toBe(101);
    expect(result.addedGuids).toHaveLength(101);
    expect(result.rootGuids).toHaveLength(101);
  });

  test("rejects unresolved generated refs and mixed cycles without writing the level", async () => {
    const cwd = makeReparentProject();
    const levelPath = join(cwd, "World.ovdrjm");
    const before = readFileSync(levelPath);

    await expect(
      applyProceduralOps([{ kind: "move", guid: "child", parent: { kind: "generated", localId: "missing" } }], {
        targetGuid: "W",
        cwd,
      }),
    ).rejects.toThrow(/generated.*missing|unresolved/i);
    expect(readFileSync(levelPath).equals(before)).toBe(true);

    await expect(
      applyProceduralOps(
        [
          {
            kind: "add",
            localId: "cycle-folder",
            parent: { kind: "existing", guid: "left" },
            class: "Folder",
            name: "CycleFolder",
            properties: {},
          },
          { kind: "move", guid: "left", parent: { kind: "generated", localId: "cycle-folder" } },
        ],
        { targetGuid: "W", cwd },
      ),
    ).rejects.toThrow(/cycle/i);
    expect(readFileSync(levelPath).equals(before)).toBe(true);
  });
});

describe("studiorpc_procedural_run", () => {
  const moveScript = `local Move = {}
Move.OnGenerate = function(parameters, targetContainer)
	for _, inst in workspace:GetDescendants() do
		if inst:IsA("BasePart") then
			inst.CFrame += Vector3.xAxis * 1
		end
	end
end
return Move
`;

  test("runs a reusable recipe and mutates the scene", async () => {
    const cwd = makeProject();
    const tools = await loadTools(cwd);
    const result = await invokeRun(tools, cwd, moveScript);

    expect(result.metadata).toMatchObject({ method: "procedural.run", updateCount: 2 });
    expect(result.metadata).not.toHaveProperty("generationId");
    const { root } = readOvdrjmRoot(cwd);
    expect((findNodeByActorGuid(root, "pA") as { CFrame: { Position: { X: number } } }).CFrame.Position.X).toBe(1);
    expect((findNodeByActorGuid(root, "pB") as { CFrame: { Position: { X: number } } }).CFrame.Position.X).toBe(11);
  });

  test("creates a non-geometry class through generic Instance.new and canonical upsert validation", async () => {
    const script = `local Generic = {}
Generic.OnGenerate = function(parameters, targetContainer)
	local light = Instance.new("PointLight")
	light.Name = "HallLight"
	light.Brightness = 125
	light.Color = Color3.fromRGB(255, 210, 170)
	light.Parent = targetContainer
end
return Generic
`;
    const cwd = makeProject();
    const tools = await loadTools(cwd);

    await invokeRun(tools, cwd, script);

    const light = workspaceChildren(cwd).find((child) => child.Name === "HallLight");
    expect(light).toMatchObject({
      InstanceType: "PointLight",
      Brightness: 125,
      Range: 300,
      Color: { R: 255, G: 210, B: 170 },
    });
  });

  test("updates a canonical property on the injected target root", async () => {
    const script = `local Generic = {}
Generic.OnGenerate = function(parameters, targetContainer)
	workspace.Gravity = 750
end
return Generic
`;
    const cwd = makeProject();
    const tools = await loadTools(cwd);

    await invokeRun(tools, cwd, script);

    expect(readOvdrjmRoot(cwd).root.Gravity).toBe(750);
  });

  test("reparents an existing node when the script assigns Parent", async () => {
    const script = `local Reparent = {}
Reparent.OnGenerate = function(parameters, targetContainer)
	local child = workspace:FindFirstChild("Child", true)
	local right = workspace:FindFirstChild("Right")
	child.Parent = right
end
return Reparent
`;
    const cwd = makeReparentProject();
    const tools = await loadTools(cwd);

    const result = await invokeRun(tools, cwd, script);

    expect(result.metadata).toMatchObject({ moveCount: 1, movedGuids: ["child"] });
    const root = readOvdrjmRoot(cwd).root;
    const left = findNodeByActorGuid(root, "left") as Record<string, unknown>;
    const right = findNodeByActorGuid(root, "right") as Record<string, unknown>;
    expect((left.LuaChildren as unknown[]).length).toBe(0);
    expect((right.LuaChildren as Array<Record<string, unknown>>).map((node) => node.ActorGuid)).toContain("child");
  });

  test("reparents an existing node below a parent created by the same script", async () => {
    const script = `local Reparent = {}
Reparent.OnGenerate = function(parameters, targetContainer)
	local generated = Instance.new("Folder")
	generated.Name = "GeneratedParent"
	generated.Parent = workspace
	local existing = workspace:FindFirstChild("Child", true)
	existing.Parent = generated
end
return Reparent
`;
    const cwd = makeReparentProject();
    const { ops } = await runProceduralScript({
      scriptSource: script,
      parameters: { Size: { X: 10, Y: 10, Z: 10 }, Attributes: {} },
      scene: readProceduralScene(cwd, "W"),
      targetGuid: "W",
    });
    const result = await applyProceduralOps(ops, { targetGuid: "W", cwd });

    expect(result).toMatchObject({ addCount: 1, moveCount: 1, movedGuids: ["child"] });
    expect(applyLevelChangesCalls).toBe(1);
    const root = readOvdrjmRoot(cwd).root;
    const generated = workspaceChildren(cwd).find((node) => node.Name === "GeneratedParent")!;
    expect((generated.LuaChildren as Array<Record<string, unknown>>).map((node) => node.ActorGuid)).toEqual(["child"]);
    expect(findNodeByActorGuid(root, "child")).toMatchObject({ ActorGuid: "child", Name: "Child" });
  });

  test("runs through the real parseArgs -> execute path without re-parsing (regression)", async () => {
    // Regression: parseArgs maps id -> scriptSource and reads the canonical file;
    // execute must NOT re-parse, because id has already been consumed.
    const cwd = makeProject();
    writeRecipe(cwd, "move", moveScript);
    const tools = await loadTools(cwd);
    const result = await invoke(tools.get("studiorpc_procedural_run")!, { id: "move" });
    expect(result.metadata).toMatchObject({ method: "procedural.run", updateCount: 2 });
  });

  test("navigates the scene with FindFirstChild / GetChildren / IsA lookups", async () => {
    const lookupScript = `local Nav = {}
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
    const result = await invokeRun(tools, cwd, lookupScript);

    expect(result.metadata).toMatchObject({ method: "procedural.run", updateCount: 1, deleteCount: 1 });
    const { root } = readOvdrjmRoot(cwd);
    expect(findNodeByActorGuid(root, "pB")).toBeUndefined();
    expect((findNodeByActorGuid(root, "pA") as { CFrame: { Position: { Y: number } } }).CFrame.Position.Y).toBe(50);
  });

  test("navigates ancestors with FindFirstAncestor / IsDescendantOf / GetFullName", async () => {
    const ancestorScript = `local Nav = {}
Nav.OnGenerate = function(parameters, targetContainer)
	local a = workspace:FindFirstChild("A")
	assert(a:FindFirstAncestor("Workspace") == workspace, "FindFirstAncestor by name")
	assert(a:FindFirstAncestorWhichIsA("Instance") ~= nil, "FindFirstAncestorWhichIsA")
	assert(a:IsDescendantOf(workspace), "IsDescendantOf")
	assert(workspace:GetChildrenNum() == 2, "GetChildrenNum")
	assert(a:GetFullName() == "Workspace.A", "GetFullName path")
	-- make one real change so the run produces an op
	a.CFrame += Vector3.yAxis * 5
end
return Nav
`;
    const cwd = makeProject();
    const tools = await loadTools(cwd);
    const result = await invokeRun(tools, cwd, ancestorScript);

    expect(result.metadata).toMatchObject({ method: "procedural.run", updateCount: 1 });
  });

  test("requires a safe recipe id and does not accept arbitrary script paths", async () => {
    const cwd = makeProject();
    const tools = await loadTools(cwd);
    const runTool = tools.get("studiorpc_procedural_run")!;
    expect(() => runTool.parameters.parse({})).toThrow();
    expect(() => runTool.parameters.parse({ id: "../escape" })).toThrow();
    expect(() => runTool.parameters.parse({ script: moveScript })).toThrow();
    expect(() => runTool.parameters.parse({ scriptPath: "x.lua" })).toThrow();
    expect(runTool.parameters.parse({ id: "move-all" })).toMatchObject({ id: "move-all" });
  });

  test("rejects before mutating when the user declines", async () => {
    const cwd = makeProject();
    const tools = await loadTools(cwd, async () => "reject");
    const result = await invokeRun(tools, cwd, moveScript);
    expect(result).toMatchObject({ output: "[Rejected by user]", metadata: { error: true } });
    // scene untouched
    const { root } = readOvdrjmRoot(cwd);
    expect((findNodeByActorGuid(root, "pA") as { CFrame: { Position: { X: number } } }).CFrame.Position.X).toBe(0);
  });
});

describe("unified reusable procedural recipes", () => {
  const bunnyScript = `local GP = require(script.Dependencies.GeometryPrimitives)
local Bunny = {}
Bunny.OnGenerate = function(parameters, targetContainer)
	local root = GP.model("Bunny", nil)
	GP.sphere("Body", Vector3.new(0, 2, 0), 2, Color3.fromRGB(245, 175, 185), "Plastic", root)
	root.Parent = targetContainer
end
return Bunny
`;

  test("exposes one procedural tool and lets the recipe choose replacement semantics", async () => {
    const cwd = makeProject();
    const tools = await loadTools(cwd);

    expect(tools.has("studiorpc_procedural_run")).toBe(true);
    expect(tools.has("studiorpc_procedural_model_save")).toBe(false);
    expect(tools.has("studiorpc_procedural_model_run")).toBe(false);
    expect(tools.has("studiorpc_procedural_model_list")).toBe(false);

    const firstRun = await invokeRun(tools, cwd, bunnyScript, "bunny-model");
    expect(firstRun.metadata).toMatchObject({ method: "procedural.run", addCount: 2 });
    const afterFirst = workspaceChildren(cwd);
    const bunniesAfterFirst = afterFirst.filter((child) => child.Name === "Bunny");
    expect(bunniesAfterFirst).toHaveLength(1);
    expect(afterFirst).toHaveLength(3); // A, B, Bunny
    expect(JSON.stringify(readOvdrjmRoot(cwd).root)).not.toContain("localId");

    const replacementScript = bunnyScript.replace(
      'local root = GP.model("Bunny", nil)',
      'local previous = workspace:FindFirstChild("Bunny")\n\tif previous then previous:Destroy() end\n\tlocal root = GP.model("Bunny", nil)',
    );
    const secondRun = await invokeRun(tools, cwd, replacementScript, "bunny-model");
    expect(secondRun.metadata).toMatchObject({ method: "procedural.run", addCount: 2, deleteCount: 2 });
    const afterSecond = workspaceChildren(cwd);
    expect(afterSecond.filter((child) => child.Name === "Bunny")).toHaveLength(1);
    expect(afterSecond).toHaveLength(3);
    expect(readFileSync(join(cwd, ".overdare", "procedural", "bunny-model", "main.lua"), "utf8")).toBe(
      replacementScript,
    );
  });

  test("reports the canonical recipe path for an unknown id", async () => {
    const cwd = makeProject();
    const tools = await loadTools(cwd);
    await expect(invoke(tools.get("studiorpc_procedural_run")!, { id: "nope" })).rejects.toThrow(
      /\.overdare[\\/]procedural[\\/]nope[\\/]main\.lua/,
    );
  });
});
