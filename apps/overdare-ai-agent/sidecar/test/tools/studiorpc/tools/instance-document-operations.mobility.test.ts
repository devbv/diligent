// @summary Verifies upsert and JSON-apply Mobility behavior across Workspace hierarchies.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../../../src/tools/studiorpc/methods/instance.upsert";
import {
  addInstancesInDocument,
  normalizeWorkspaceMobility,
  requireDocumentRoot,
  updateInstancesInDocument,
} from "../../../../src/tools/studiorpc/tools/instance-document-operations";
import { executeInstanceUpsertInner } from "../../../../src/tools/studiorpc/tools/instance-upsert-tool";
import { findNodeByActorGuid, type OvdrjmNode } from "../../../../src/tools/studiorpc/tools/ovdrjm-utils";

function makeDocument(): {
  document: Record<string, unknown>;
  topGuid: string;
  childGuid: string;
  workspaceGuid: string;
} {
  const workspaceGuid = "WORKSPACE";
  const topGuid = "TOP";
  const childGuid = "CHILD";
  const document = {
    Root: {
      InstanceType: "Workspace",
      ActorGuid: workspaceGuid,
      Name: "Workspace",
      LuaChildren: [
        {
          InstanceType: "Folder",
          ActorGuid: topGuid,
          Name: "hello",
          LuaChildren: [
            {
              InstanceType: "Model",
              ActorGuid: childGuid,
              Name: "hey",
              LuaChildren: [{ InstanceType: "Part", ActorGuid: "GRANDCHILD", Name: "k" }],
            },
          ],
        },
      ],
    },
  };
  return { document, topGuid, childGuid, workspaceGuid };
}

function node(document: Record<string, unknown>, guid: string): OvdrjmNode {
  const found = findNodeByActorGuid(requireDocumentRoot(document), guid);
  if (!found) throw new Error(`missing ${guid}`);
  return found;
}

describe("Workspace Mobility rules", () => {
  test("applies Mobility to a direct child of Workspace", () => {
    const { document, topGuid } = makeDocument();
    const mobilityInfo: string[] = [];
    updateInstancesInDocument(requireDocumentRoot(document), [{ guid: topGuid, properties: { Mobility: "Movable" } }], {
      mobilityInfo,
    });
    expect(node(document, topGuid).Mobility).toBe("Movable");
    expect(mobilityInfo).toEqual([]);
  });

  test("ignores only Mobility on a deeper upsert and returns info", () => {
    const { document, childGuid } = makeDocument();
    const mobilityInfo: string[] = [];
    updateInstancesInDocument(
      requireDocumentRoot(document),
      [{ guid: childGuid, name: "Renamed", properties: { Mobility: "Static", CastShadow: true } }],
      { mobilityInfo },
    );
    expect("Mobility" in node(document, childGuid)).toBe(false);
    expect(node(document, childGuid).CastShadow).toBe(true);
    expect(node(document, childGuid).Name).toBe("Renamed");
    expect(mobilityInfo).toEqual([
      "Ignored Mobility for CHILD: Mobility can only be changed on a direct child of Workspace.",
    ]);
  });

  test("ignores Mobility when adding below a top-level object", () => {
    const { document, topGuid } = makeDocument();
    const mobilityInfo: string[] = [];
    const [added] = addInstancesInDocument(
      document,
      [{ class: "Part", parentGuid: topGuid, name: "Nested", properties: { Mobility: "Static" } }],
      { mobilityInfo },
    );
    expect("Mobility" in node(document, added.guid)).toBe(false);
    expect(mobilityInfo).toHaveLength(1);
  });

  test("keeps Mobility when adding a direct child of Workspace", () => {
    const { document, workspaceGuid } = makeDocument();
    const [added] = addInstancesInDocument(document, [
      { class: "Part", parentGuid: workspaceGuid, name: "TopPart", properties: { Mobility: "Movable" } },
    ]);
    expect(node(document, added.guid).Mobility).toBe("Movable");
  });

  test("JSON apply normalizes explicit descendant values to the top-level value", () => {
    const { document, topGuid, childGuid } = makeDocument();
    node(document, topGuid).Mobility = "Static";
    node(document, childGuid).Mobility = "Movable";
    node(document, "GRANDCHILD").Mobility = "Movable";
    normalizeWorkspaceMobility(requireDocumentRoot(document));
    expect(node(document, childGuid).Mobility).toBe("Static");
    expect(node(document, "GRANDCHILD").Mobility).toBe("Static");
  });

  test("JSON apply materializes a Static top-level onto keyless descendants (default is Movable)", () => {
    // The engine default is Movable, so a Static top-level must be written onto
    // otherwise-keyless descendants or they would attach as Movable.
    const { document, topGuid, childGuid } = makeDocument();
    node(document, topGuid).Mobility = "Static";
    normalizeWorkspaceMobility(requireDocumentRoot(document));
    expect(node(document, childGuid).Mobility).toBe("Static");
    expect(node(document, "GRANDCHILD").Mobility).toBe("Static");
  });

  test("JSON apply pulls a stale Static descendant back to Movable under a default top-level", () => {
    const { document, childGuid } = makeDocument();
    // Top-level left unset -> effective Movable; a descendant carries a stale Static.
    node(document, childGuid).Mobility = "Static";
    normalizeWorkspaceMobility(requireDocumentRoot(document));
    expect(node(document, childGuid).Mobility).toBe("Movable");
  });

  test("JSON apply leaves keyless descendants keyless under a Movable top-level (no churn)", () => {
    const { document, topGuid, childGuid } = makeDocument();
    node(document, topGuid).Mobility = "Movable";
    normalizeWorkspaceMobility(requireDocumentRoot(document));
    expect("Mobility" in node(document, childGuid)).toBe(false);
    expect("Mobility" in node(document, "GRANDCHILD")).toBe(false);
  });
});

describe("instance.upsert Mobility cascade (tool path)", () => {
  const createdDirs: string[] = [];
  afterEach(() => {
    for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Workspace → Folder "Lobby" (top-level) → Part "Wall" with a stale, mismatched Mobility. */
  function makeProject(): { cwd: string; lobbyGuid: string; wallGuid: string } {
    const cwd = join(tmpdir(), `sidecar-mobility-${process.pid}-${Date.now()}-${createdDirs.length}`);
    mkdirSync(cwd, { recursive: true });
    createdDirs.push(cwd);
    const lobbyGuid = "LOBBY";
    const wallGuid = "WALL";
    writeFileSync(join(cwd, "World.umap"), "");
    writeFileSync(
      join(cwd, "World.ovdrjm"),
      JSON.stringify({
        Root: {
          InstanceType: "Workspace",
          ActorGuid: "WS",
          Name: "Workspace",
          LuaChildren: [
            {
              InstanceType: "Folder",
              ActorGuid: lobbyGuid,
              Name: "Lobby",
              Mobility: "Static",
              LuaChildren: [{ InstanceType: "Part", ActorGuid: wallGuid, Name: "Wall", Mobility: "Movable" }],
            },
          ],
        },
      }),
    );
    return { cwd, lobbyGuid, wallGuid };
  }

  function readWall(cwd: string, wallGuid: string): OvdrjmNode {
    const doc = JSON.parse(readFileSync(join(cwd, "World.ovdrjm"), "utf-8")) as Record<string, unknown>;
    const found = findNodeByActorGuid(requireDocumentRoot(doc), wallGuid);
    if (!found) throw new Error("wall missing");
    return found;
  }

  test("changing a top-level object's Mobility cascades to descendants", async () => {
    const { cwd, lobbyGuid, wallGuid } = makeProject();
    await executeInstanceUpsertInner(
      parseArgs({ items: [{ guid: lobbyGuid, properties: { Mobility: "Movable" } }] }),
      cwd,
      {
        applyAndSaveChanges: false,
      },
    );
    expect(readWall(cwd, wallGuid).Mobility).toBe("Movable");

    await executeInstanceUpsertInner(
      parseArgs({ items: [{ guid: lobbyGuid, properties: { Mobility: "Static" } }] }),
      cwd,
      {
        applyAndSaveChanges: false,
      },
    );
    expect(readWall(cwd, wallGuid).Mobility).toBe("Static");
  });
});

describe("instance.upsert Mobility cascade (tool path)", () => {
  const createdDirs: string[] = [];
  afterEach(() => {
    for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Workspace → Folder "Lobby" (top-level) → Part "Wall" with a stale, mismatched Mobility. */
  function makeProject(): { cwd: string; lobbyGuid: string; wallGuid: string } {
    const cwd = join(tmpdir(), `sidecar-mobility-${process.pid}-${Date.now()}-${createdDirs.length}`);
    mkdirSync(cwd, { recursive: true });
    createdDirs.push(cwd);
    const lobbyGuid = "LOBBY";
    const wallGuid = "WALL";
    writeFileSync(join(cwd, "World.umap"), "");
    writeFileSync(
      join(cwd, "World.ovdrjm"),
      JSON.stringify({
        Root: {
          InstanceType: "Workspace",
          ActorGuid: "WS",
          Name: "Workspace",
          LuaChildren: [
            {
              InstanceType: "Folder",
              ActorGuid: lobbyGuid,
              Name: "Lobby",
              Mobility: "Static",
              LuaChildren: [{ InstanceType: "Part", ActorGuid: wallGuid, Name: "Wall", Mobility: "Movable" }],
            },
          ],
        },
      }),
    );
    return { cwd, lobbyGuid, wallGuid };
  }

  function readWall(cwd: string, wallGuid: string): OvdrjmNode {
    const doc = JSON.parse(readFileSync(join(cwd, "World.ovdrjm"), "utf-8")) as Record<string, unknown>;
    const found = findNodeByActorGuid(requireDocumentRoot(doc), wallGuid);
    if (!found) throw new Error("wall missing");
    return found;
  }

  test("changing a top-level object's Mobility cascades to descendants", async () => {
    const { cwd, lobbyGuid, wallGuid } = makeProject();
    await executeInstanceUpsertInner(
      parseArgs({ items: [{ guid: lobbyGuid, properties: { Mobility: "Movable" } }] }),
      cwd,
      {
        applyAndSaveChanges: false,
      },
    );
    expect(readWall(cwd, wallGuid).Mobility).toBe("Movable");

    await executeInstanceUpsertInner(
      parseArgs({ items: [{ guid: lobbyGuid, properties: { Mobility: "Static" } }] }),
      cwd,
      {
        applyAndSaveChanges: false,
      },
    );
    expect(readWall(cwd, wallGuid).Mobility).toBe("Static");
  });
});
