// @summary Verifies the Studio v2 tool path: wire conversion, save-after-write, validation and failure handling.
//
// Studio is stood in for by a local JSON-RPC socket server rather than a module
// mock, so the tools exercise the real transport and nothing leaks into the
// other test files that mock ./rpc.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import type { Tool } from "@diligent/core/tool-contract";
import { createStudioRpcToolProvider } from "../../../src/tools/studiorpc";
import { checkResult } from "../../../src/tools/studiorpc/tools/v2/result";

interface RpcCall {
  method: string;
  params?: Record<string, unknown>;
}

type Responder = (method: string, params?: Record<string, unknown>) => unknown;

const rpcCalls: RpcCall[] = [];
let respond: Responder;

const WORKSPACE_GUID = "WS";
const FOLDER_A_GUID = "FA";
const FOLDER_B_GUID = "FB";
const PART_GUID = "P1";
const SCRIPT_GUID = "S1";
const SCRIPT_SOURCE = "print(1)\nprint(2)\n";

type WorldNode = Record<string, unknown> & { ActorGuid?: string; LuaChildren?: WorldNode[] };

function makeWorld(): WorldNode {
  return {
    InstanceType: "Workspace",
    ActorGuid: WORKSPACE_GUID,
    Name: "Workspace",
    LuaChildren: [
      { InstanceType: "Folder", ActorGuid: FOLDER_A_GUID, Name: "FolderA", LuaChildren: [] },
      { InstanceType: "Folder", ActorGuid: FOLDER_B_GUID, Name: "FolderB", LuaChildren: [] },
      { InstanceType: "Part", ActorGuid: PART_GUID, Name: "Part1" },
      { InstanceType: "Script", ActorGuid: SCRIPT_GUID, Name: "Greeter", Source: SCRIPT_SOURCE },
    ],
  };
}

function findWorldNode(node: WorldNode, guid: string): WorldNode | undefined {
  if (node.ActorGuid === guid) return node;
  for (const child of node.LuaChildren ?? []) {
    const found = findWorldNode(child, guid);
    if (found) return found;
  }
  return undefined;
}

let world: WorldNode;
let issuedGuids = 0;

/**
 * Stands in for Studio: lists the top-level instance for level.browse, serves
 * instance.read from `world`, and issues GUIDs for instance.create. Studio has
 * no handle for the level root, so an unknown ActorGuid resolves to nothing.
 */
function studioResponder(method: string, params?: Record<string, unknown>): unknown {
  if (method === "level.browse") {
    // Studio answers with the hierarchy only — guid, name, class and children.
    const lite = (node: WorldNode): WorldNode => ({
      ActorGuid: node.ActorGuid,
      Name: node.Name,
      InstanceType: node.InstanceType,
      ...(node.LuaChildren ? { LuaChildren: node.LuaChildren.map(lite) } : {}),
    });
    return { level: [lite(world)] };
  }
  if (method === "instance.read") {
    const actorGuid = params?.ActorGuid as string;
    const node = findWorldNode(world, actorGuid);
    if (!node) return { success: true };
    const instance = structuredClone(node);
    if (params?.Depth === 0) delete instance.LuaChildren;
    return { success: true, instance };
  }
  if (method === "instance.create") {
    const instances = (params?.Instances as unknown[]) ?? [];
    return { success: true, ActorGuids: instances.map(() => `NEW-${++issuedGuids}`) };
  }
  return { success: true };
}

let server: net.Server;
const previousEnv: Record<string, string | undefined> = {};

function rememberEnv(key: string): void {
  previousEnv[key] = process.env[key];
}

function restoreEnv(key: string): void {
  if (previousEnv[key] === undefined) delete process.env[key];
  else process.env[key] = previousEnv[key];
}

beforeAll(async () => {
  rememberEnv("STUDIO_HOST");
  rememberEnv("STUDIO_PORT");

  server = net.createServer((socket) => {
    const lines = readline.createInterface({ input: socket });
    lines.on("line", (line) => {
      const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
      rpcCalls.push({ method: request.method, params: request.params });
      const result = respond(request.method, request.params);
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  process.env.STUDIO_HOST = "127.0.0.1";
  process.env.STUDIO_PORT = String((server.address() as net.AddressInfo).port);
});

afterAll(async () => {
  restoreEnv("STUDIO_HOST");
  restoreEnv("STUDIO_PORT");
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const createdDirs: string[] = [];

function makeStudioProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "studiorpc-v2-"));
  writeFileSync(join(cwd, "Test.umap"), "");
  writeFileSync(join(cwd, "Test.ovdrjm"), JSON.stringify({ Root: makeWorld() }, null, 2));
  createdDirs.push(cwd);
  return cwd;
}

async function loadTools(cwd: string): Promise<Map<string, Tool>> {
  const provider = createStudioRpcToolProvider();
  const tools = await provider.createTools({ cwd, host: { approve: async () => "once" } });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function toolContext() {
  return { toolCallId: "test", signal: new AbortController().signal, abort: () => {} };
}

function methodsCalled(): string[] {
  return rpcCalls.map((entry) => entry.method);
}

function paramsOf(method: string): Record<string, unknown> | undefined {
  return rpcCalls.find((entry) => entry.method === method)?.params;
}

beforeEach(() => {
  rememberEnv("STUDIO_API_VERSION");
  process.env.STUDIO_API_VERSION = "v2";
  rpcCalls.length = 0;
  issuedGuids = 0;
  world = makeWorld();
  respond = studioResponder;
});

afterEach(() => {
  restoreEnv("STUDIO_API_VERSION");
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("checkResult", () => {
  test("rejects an explicit failure", () => {
    expect(() => checkResult("instance.move", { success: false, message: "no such GUID" })).toThrow(
      /instance\.move failed: no such GUID/,
    );
    expect(() => checkResult("instance.move", { success: false })).toThrow(/\(no message\)/);
  });

  test("treats any non-empty message on a successful result as a partial failure", () => {
    expect(() => checkResult("instance.delete", { success: true, message: "1 of 2 instances not found" })).toThrow(
      /instance\.delete partial failure: 1 of 2 instances not found/,
    );
  });

  test("accepts results that carry no failure signal", () => {
    for (const result of [{ success: true }, { success: true, message: "" }, { success: true, message: "  " }, {}]) {
      expect(() => checkResult("instance.update", result)).not.toThrow();
    }
    expect(() => checkResult("instance.update", undefined)).not.toThrow();
    expect(() => checkResult("instance.update", "ok")).not.toThrow();
  });
});

describe("v2 argument conversion", () => {
  test("maps instance_read recursive onto Depth", async () => {
    const tools = await loadTools(makeStudioProject());
    const read = tools.get("studiorpc_instance_read")!;

    await read.execute({ guid: PART_GUID, recursive: true }, toolContext());
    expect(rpcCalls.at(-1)).toEqual({ method: "instance.read", params: { ActorGuid: PART_GUID, Depth: -1 } });

    await read.execute({ guid: PART_GUID, recursive: false }, toolContext());
    expect(rpcCalls.at(-1)).toEqual({ method: "instance.read", params: { ActorGuid: PART_GUID, Depth: 0 } });
  });

  test("groups instance_move items sharing a parent into one entry", async () => {
    const tools = await loadTools(makeStudioProject());

    await tools.get("studiorpc_instance_move")!.execute(
      {
        items: [
          { guid: PART_GUID, parentGuid: FOLDER_A_GUID },
          { guid: SCRIPT_GUID, parentGuid: FOLDER_A_GUID },
          { guid: FOLDER_B_GUID, parentGuid: FOLDER_A_GUID },
        ],
      },
      toolContext(),
    );

    expect(paramsOf("instance.move")).toEqual({
      Moves: [{ ParentActorGuid: FOLDER_A_GUID, ActorGuids: [PART_GUID, SCRIPT_GUID, FOLDER_B_GUID] }],
    });
  });

  test("splits instance_move into one entry per distinct parent", async () => {
    const tools = await loadTools(makeStudioProject());

    await tools.get("studiorpc_instance_move")!.execute(
      {
        items: [
          { guid: PART_GUID, parentGuid: FOLDER_A_GUID },
          { guid: SCRIPT_GUID, parentGuid: FOLDER_B_GUID },
          { guid: FOLDER_B_GUID, parentGuid: FOLDER_A_GUID },
        ],
      },
      toolContext(),
    );

    expect(paramsOf("instance.move")).toEqual({
      Moves: [
        { ParentActorGuid: FOLDER_A_GUID, ActorGuids: [PART_GUID, FOLDER_B_GUID] },
        { ParentActorGuid: FOLDER_B_GUID, ActorGuids: [SCRIPT_GUID] },
      ],
    });
  });

  test("flattens instance_delete items into an ActorGuids string array", async () => {
    const tools = await loadTools(makeStudioProject());

    await tools
      .get("studiorpc_instance_delete")!
      .execute({ items: [{ targetGuid: PART_GUID }, { targetGuid: FOLDER_B_GUID }] }, toolContext());

    expect(paramsOf("instance.delete")).toEqual({ ActorGuids: [PART_GUID, FOLDER_B_GUID] });
  });

  test("issues one instance.create per parent and reports the GUIDs Studio returned", async () => {
    const tools = await loadTools(makeStudioProject());

    const result = await tools.get("studiorpc_instance_upsert")!.execute(
      {
        items: [
          { class: "Folder", parentGuid: FOLDER_A_GUID, name: "One", properties: {} },
          { class: "Folder", parentGuid: FOLDER_B_GUID, name: "Two", properties: {} },
          { class: "Folder", parentGuid: FOLDER_A_GUID, name: "Three", properties: {} },
        ],
      },
      toolContext(),
    );

    const creates = rpcCalls.filter((entry) => entry.method === "instance.create");
    expect(creates).toHaveLength(2);
    expect(creates[0].params).toEqual({
      ParentActorGuid: FOLDER_A_GUID,
      Instances: [
        { InstanceType: "Folder", Name: "One" },
        { InstanceType: "Folder", Name: "Three" },
      ],
    });
    expect(creates[1].params).toEqual({
      ParentActorGuid: FOLDER_B_GUID,
      Instances: [{ InstanceType: "Folder", Name: "Two" }],
    });

    // No client-side GUID reaches the output: every reported GUID came back from Studio.
    expect(result.metadata?.added).toEqual([
      { guid: "NEW-1", name: "One", class: "Folder" },
      { guid: "NEW-3", name: "Two", class: "Folder" },
      { guid: "NEW-2", name: "Three", class: "Folder" },
    ]);
    expect(result.output).toContain('name="Three" class="Folder" guid="NEW-2"');
  });

  test("sends only the changed properties of an instance_upsert update", async () => {
    const tools = await loadTools(makeStudioProject());

    await tools
      .get("studiorpc_instance_upsert")!
      .execute({ items: [{ guid: PART_GUID, name: "Renamed", properties: {} }] }, toolContext());

    expect(paramsOf("instance.update")).toEqual({ Instances: [{ ActorGuid: PART_GUID, Name: "Renamed" }] });
  });
});

describe("v2 level.save.file", () => {
  const writes: Array<[string, Record<string, unknown>]> = [
    [
      "studiorpc_instance_upsert",
      { items: [{ class: "Folder", parentGuid: FOLDER_A_GUID, name: "X", properties: {} }] },
    ],
    ["studiorpc_instance_move", { items: [{ guid: PART_GUID, parentGuid: FOLDER_A_GUID }] }],
    ["studiorpc_instance_delete", { items: [{ targetGuid: PART_GUID }] }],
    ["studiorpc_script_add", { class: "Script", parentGuid: FOLDER_A_GUID, name: "S", source: "print(1)" }],
    ["studiorpc_script_edit", { targetGuid: SCRIPT_GUID, old_string: "print(1)", new_string: "print(9)" }],
    ["studiorpc_script_delete", { targetGuid: SCRIPT_GUID }],
  ];

  for (const [name, args] of writes) {
    test(`${name} saves the level after the write succeeds`, async () => {
      const tools = await loadTools(makeStudioProject());
      const result = await tools.get(name)!.execute(args, toolContext());
      expect(result.metadata?.error).toBeUndefined();
      expect(methodsCalled().at(-1)).toBe("level.save.file");
    });
  }

  const reads: Array<[string, Record<string, unknown>]> = [
    ["studiorpc_instance_read", { guid: PART_GUID, recursive: false }],
    ["studiorpc_script_read", { targetGuid: SCRIPT_GUID }],
    ["studiorpc_script_grep", { pattern: "print" }],
  ];

  for (const [name, args] of reads) {
    test(`${name} does not save the level`, async () => {
      const tools = await loadTools(makeStudioProject());
      const result = await tools.get(name)!.execute(args, toolContext());
      expect(result.metadata?.error).toBeUndefined();
      expect(methodsCalled()).not.toContain("level.save.file");
    });
  }
});

describe("v2 failure reporting", () => {
  test("does not report success when Studio returns a partial failure", async () => {
    const tools = await loadTools(makeStudioProject());
    respond = (method, params) => {
      if (method === "instance.delete") return { success: true, message: "1 instance could not be deleted" };
      return studioResponder(method, params);
    };

    const result = await tools.get("studiorpc_script_delete")!.execute({ targetGuid: SCRIPT_GUID }, toolContext());

    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("partial failure");
    expect(methodsCalled()).not.toContain("level.save.file");
  });

  test("does not save the level when Studio reports success:false", async () => {
    const tools = await loadTools(makeStudioProject());
    respond = (method, params) => {
      if (method === "instance.move") return { success: false, message: "target is locked" };
      return studioResponder(method, params);
    };

    await expect(
      tools
        .get("studiorpc_instance_move")!
        .execute({ items: [{ guid: PART_GUID, parentGuid: FOLDER_A_GUID }] }, toolContext()),
    ).rejects.toThrow(/instance\.move failed: target is locked/);
    expect(methodsCalled()).not.toContain("level.save.file");
  });

  test("does not report success when script_add gets a partial failure", async () => {
    const tools = await loadTools(makeStudioProject());
    respond = (method, params) => {
      if (method === "instance.create") return { success: true, ActorGuids: [], message: "parent is read-only" };
      return studioResponder(method, params);
    };

    const result = await tools
      .get("studiorpc_script_add")!
      .execute({ class: "Script", parentGuid: FOLDER_A_GUID, name: "S", source: "print(1)" }, toolContext());

    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("partial failure");
    expect(methodsCalled()).not.toContain("level.save.file");
  });
});

describe("v2 validation", () => {
  test("refuses to move a Service class and sends no write", async () => {
    const tools = await loadTools(makeStudioProject());

    const result = await tools
      .get("studiorpc_instance_move")!
      .execute({ items: [{ guid: WORKSPACE_GUID, parentGuid: FOLDER_A_GUID }] }, toolContext());

    expect(result.metadata).toMatchObject({
      error: true,
      status: { code: "protected_service_class", operation: "instance.move", class: "Workspace" },
    });
    expect(methodsCalled()).toEqual(["level.browse"]);
  });

  test("refuses a hierarchy cycle and sends no write", async () => {
    const tools = await loadTools(makeStudioProject());

    const result = await tools
      .get("studiorpc_instance_move")!
      .execute({ items: [{ guid: FOLDER_A_GUID, parentGuid: FOLDER_A_GUID }] }, toolContext());

    expect(result.metadata).toMatchObject({ error: true, status: { code: "hierarchy_cycle" } });
    expect(methodsCalled()).toEqual(["level.browse"]);
  });

  test("refuses to delete a Service class and sends no write", async () => {
    const tools = await loadTools(makeStudioProject());

    const result = await tools
      .get("studiorpc_instance_delete")!
      .execute({ items: [{ targetGuid: WORKSPACE_GUID }] }, toolContext());

    expect(result.metadata).toMatchObject({
      error: true,
      status: { code: "protected_service_class", operation: "instance.delete" },
    });
    expect(methodsCalled()).toEqual(["level.browse"]);
  });

  test("reports a missing GUID for instance_delete instead of forwarding it", async () => {
    const tools = await loadTools(makeStudioProject());

    const result = await tools
      .get("studiorpc_instance_delete")!
      .execute({ items: [{ targetGuid: "no-such-guid" }] }, toolContext());

    expect(result.metadata).toMatchObject({ error: true, status: { code: "missing_target_guid" } });
    expect(methodsCalled()).toEqual(["level.browse"]);
  });

  test("refuses to delete a non-script instance through script_delete", async () => {
    const tools = await loadTools(makeStudioProject());

    const result = await tools.get("studiorpc_script_delete")!.execute({ targetGuid: PART_GUID }, toolContext());

    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("not a script");
    expect(methodsCalled()).toEqual(["instance.read"]);
  });

  test("refuses to edit a non-script instance through script_edit", async () => {
    const tools = await loadTools(makeStudioProject());

    const result = await tools
      .get("studiorpc_script_edit")!
      .execute({ targetGuid: PART_GUID, old_string: "a", new_string: "b" }, toolContext());

    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("not a script");
    expect(methodsCalled()).toEqual(["instance.read"]);
  });
});

describe("v1 stays on the file path", () => {
  test("instance_delete edits the .ovdrjm and applies the level when the version is v1", async () => {
    process.env.STUDIO_API_VERSION = "v1";
    const cwd = makeStudioProject();
    const tools = await loadTools(cwd);

    const result = await tools
      .get("studiorpc_instance_delete")!
      .execute({ items: [{ targetGuid: PART_GUID }] }, toolContext());

    expect(methodsCalled()).toEqual(["level.apply"]);
    expect(readFileSync(join(cwd, "Test.ovdrjm"), "utf-8")).not.toContain(PART_GUID);
    expect(result.metadata).toMatchObject({ method: "instance.delete", targetGuids: [PART_GUID], deleteCount: 1 });
  });

  test("script_read returns the same output on both paths", async () => {
    const cwd = makeStudioProject();

    process.env.STUDIO_API_VERSION = "v2";
    const v2Tools = await loadTools(cwd);
    const v2 = await v2Tools.get("studiorpc_script_read")!.execute({ targetGuid: SCRIPT_GUID }, toolContext());

    process.env.STUDIO_API_VERSION = "v1";
    const v1Tools = await loadTools(cwd);
    const v1 = await v1Tools.get("studiorpc_script_read")!.execute({ targetGuid: SCRIPT_GUID }, toolContext());

    expect(v2.output).toBe(v1.output);
    expect(v2.metadata).toEqual(v1.metadata);
  });

  test("script_delete returns the same output and metadata on both paths", async () => {
    const cwd = makeStudioProject();

    process.env.STUDIO_API_VERSION = "v2";
    const v2Tools = await loadTools(cwd);
    const v2 = await v2Tools.get("studiorpc_script_delete")!.execute({ targetGuid: SCRIPT_GUID }, toolContext());

    process.env.STUDIO_API_VERSION = "v1";
    const v1Tools = await loadTools(cwd);
    const v1 = await v1Tools.get("studiorpc_script_delete")!.execute({ targetGuid: SCRIPT_GUID }, toolContext());

    expect(v2.output).toBe(v1.output);
    expect(v2.metadata).toEqual(v1.metadata);
  });
});
