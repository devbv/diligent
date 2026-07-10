// @summary Tests the pure end-state diff that derives procedural ops.

import { describe, expect, test } from "bun:test";
import { deriveProceduralOps } from "../../src/procedural/ops";
import type { ProceduralSceneNode, ProceduralSerializedNode } from "../../src/procedural/types";

const cframe = (x: number, y: number, z: number) => ({
  Position: { X: x, Y: y, Z: z },
  Orientation: { X: 0, Y: 0, Z: 0 },
});

function scene(children: ProceduralSceneNode[]): ProceduralSceneNode {
  return { class: "Workspace", name: "Workspace", guid: "W", properties: {}, children };
}

const partSnap = (guid: string, name: string, x: number): ProceduralSceneNode => ({
  class: "Part",
  name,
  guid,
  properties: { CFrame: cframe(x, 0, 0), Size: { X: 1, Y: 1, Z: 1 } },
  children: [],
});

const partOut = (guid: string, name: string, x: number): ProceduralSerializedNode => ({
  class: "Part",
  name,
  guid,
  properties: { CFrame: cframe(x, 0, 0), Size: { X: 1, Y: 1, Z: 1 } },
});

describe("deriveProceduralOps", () => {
  test("no scene: every top-level node is an add attached to the target", () => {
    const fresh: ProceduralSerializedNode[] = [
      {
        class: "Model",
        name: "Root",
        properties: { WorldPivot: cframe(0, 0, 0) },
        children: [{ class: "Part", name: "Leaf", properties: { Size: { X: 2, Y: 2, Z: 2 } } }],
      },
    ];
    const ops = deriveProceduralOps(fresh, undefined, "TARGET");
    expect(ops).toEqual([
      {
        kind: "add",
        parentGuid: "TARGET",
        node: {
          class: "Model",
          name: "Root",
          properties: { WorldPivot: cframe(0, 0, 0) },
          children: [{ class: "Part", name: "Leaf", properties: { Size: { X: 2, Y: 2, Z: 2 } } }],
        },
      },
    ]);
  });

  test("moved node yields a single update with only the changed CFrame", () => {
    const s = scene([partSnap("gA", "A", 0), partSnap("gB", "B", 10)]);
    const out = [partOut("gA", "A", 1), partOut("gB", "B", 10)];
    const ops = deriveProceduralOps(out, s, "W");
    expect(ops).toEqual([{ kind: "update", guid: "gA", class: "Part", properties: { CFrame: cframe(1, 0, 0) } }]);
  });

  test("unchanged node yields no op (float-noise tolerant)", () => {
    const s = scene([partSnap("gA", "A", 5)]);
    const out: ProceduralSerializedNode[] = [
      {
        class: "Part",
        name: "A",
        guid: "gA",
        properties: { CFrame: cframe(5 + 1e-9, 0, 0), Size: { X: 1, Y: 1, Z: 1 } },
      },
    ];
    expect(deriveProceduralOps(out, s, "W")).toEqual([]);
  });

  test("node absent from output yields a delete with its depth", () => {
    const s = scene([
      partSnap("gA", "A", 0),
      { class: "Model", name: "Grp", guid: "gG", properties: {}, children: [partSnap("gB", "B", 0)] },
    ]);
    const out = [partOut("gA", "A", 0), { class: "Model", name: "Grp", guid: "gG", properties: {}, children: [] }];
    const ops = deriveProceduralOps(out, s, "W");
    expect(ops).toEqual([{ kind: "delete", guid: "gB", depth: 2 }]);
  });

  test("fresh node under an injected parent adds with the parent's guid", () => {
    const s = scene([{ class: "Model", name: "Grp", guid: "gG", properties: {}, children: [] }]);
    const out: ProceduralSerializedNode[] = [
      {
        class: "Model",
        name: "Grp",
        guid: "gG",
        properties: {},
        children: [{ class: "Part", name: "New", properties: { Size: { X: 1, Y: 1, Z: 1 } } }],
      },
    ];
    const ops = deriveProceduralOps(out, s, "W");
    expect(ops).toEqual([
      {
        kind: "add",
        parentGuid: "gG",
        node: { class: "Part", name: "New", properties: { Size: { X: 1, Y: 1, Z: 1 } } },
      },
    ]);
  });

  test("rename yields an update carrying the new name", () => {
    const s = scene([partSnap("gA", "Old", 0)]);
    const out = [partOut("gA", "New", 0)];
    expect(deriveProceduralOps(out, s, "W")).toEqual([
      { kind: "update", guid: "gA", class: "Part", name: "New", properties: {} },
    ]);
  });

  test("mixed transform: update + delete + add in one diff", () => {
    const s = scene([partSnap("gA", "A", 0), partSnap("gC", "C", 5)]);
    const out: ProceduralSerializedNode[] = [
      partOut("gA", "A", 1),
      { class: "Part", name: "Fresh", properties: { Size: { X: 3, Y: 3, Z: 3 } } },
    ];
    const ops = deriveProceduralOps(out, s, "W");
    expect(ops).toContainEqual({ kind: "update", guid: "gA", class: "Part", properties: { CFrame: cframe(1, 0, 0) } });
    expect(ops).toContainEqual({
      kind: "add",
      parentGuid: "W",
      node: { class: "Part", name: "Fresh", properties: { Size: { X: 3, Y: 3, Z: 3 } } },
    });
    expect(ops).toContainEqual({ kind: "delete", guid: "gC", depth: 1 });
    expect(ops).toHaveLength(3);
  });
});
