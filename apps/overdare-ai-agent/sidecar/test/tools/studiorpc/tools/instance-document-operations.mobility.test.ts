// @summary Verifies upsert and JSON-apply Mobility behavior across Workspace hierarchies.

import { describe, expect, test } from "bun:test";
import {
  addInstancesInDocument,
  normalizeWorkspaceMobility,
  requireDocumentRoot,
  updateInstancesInDocument,
} from "../../../../src/tools/studiorpc/tools/instance-document-operations";
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

  test("JSON apply does not add Mobility to descendants where it is unset", () => {
    const { document, topGuid, childGuid } = makeDocument();
    node(document, topGuid).Mobility = "Static";
    normalizeWorkspaceMobility(requireDocumentRoot(document));
    expect("Mobility" in node(document, childGuid)).toBe(false);
    expect("Mobility" in node(document, "GRANDCHILD")).toBe(false);
  });

  test("JSON apply leaves descendants unchanged when the top-level value is unset", () => {
    const { document, childGuid } = makeDocument();
    node(document, childGuid).Mobility = "Movable";
    normalizeWorkspaceMobility(requireDocumentRoot(document));
    expect(node(document, childGuid).Mobility).toBe("Movable");
  });
});
