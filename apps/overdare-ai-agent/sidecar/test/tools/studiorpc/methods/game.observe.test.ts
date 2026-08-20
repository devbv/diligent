// @summary Tests that observe's reply checks its own one-instant claim and keeps per-miss help.

import { describe, expect, test } from "bun:test";
import { normalizeArgs, params, postProcess } from "../../../../src/tools/studiorpc/methods/game.observe";

function reply() {
  return {
    character: { status: "ok", data: { success: true, character: {} } },
    instances: {
      status: "ok",
      data: {
        success: true,
        requested: 2,
        found: 1,
        instances: [
          { query: "Bed", status: "ok", path: "Glasshouse.RackA.Bed" },
          { query: "BedZzz", status: "notFound" },
        ],
        notFound: ["BedZzz"],
        workspaceNames: ["Camera", "Baseplate", "Glasshouse", "RackA", "Bed", "Tray1"],
        workspaceNameCount: 6,
      },
    },
    requestedSections: ["character", "instances"],
    outcome: "ok",
  };
}

describe("game.observe reply shape", () => {
  test("a name that missed is still told what it probably meant", () => {
    const out = postProcess(reply()) as {
      instances: { instances: { query: string; nearestNames?: string[] }[] };
    };
    const miss = out.instances.instances.find((entry) => entry.query === "BedZzz");
    expect(miss?.nearestNames?.[0]).toBe("Bed");
  });
  test("a section's own fields sit on the section, not under data", () => {
    const out = postProcess(reply()) as Record<string, Record<string, unknown>>;

    expect(out.instances.data).toBeUndefined();
    expect(out.instances.status).toBe("ok");
    expect(Array.isArray(out.instances.instances)).toBe(true);
    expect(out.instances.success).toBeUndefined();
    expect(out.character.character).toBeUndefined();
    expect(out.character.data).toBeUndefined();
    expect(out.character.status).toBe("ok");
    expect(Object.keys(out.instances)[0]).toBe("status");
  });

  test("a payload cannot overwrite the word that describes the read", () => {
    const collided = {
      instances: { status: "ok", data: { status: "notFound", instances: [] } },
    };
    const out = postProcess(collided) as { instances: Record<string, unknown> };
    expect(out.instances.status).toBe("ok");
  });

  test("a reply with no instances section is left alone rather than crashed on", () => {
    const bare = { ui: { status: "ok", data: {} } };
    expect(postProcess(bare)).toEqual({ ui: { status: "ok" } });
  });

  test("a narrowed read says which of the fields it was given came back under nothing", () => {
    const reply = {
      ui: {
        status: "ok",
        data: { elements: [{ path: "HUD.Tally", Text: "4", Visible: true, readable: true }] },
      },
    };
    const out = postProcess(reply, { ui: { fields: ["Text", "readable", "contrast", "occludedFraction"] } }) as {
      ui: { fieldsNotAnswered?: string[] };
    };
    expect(out.ui.fieldsNotAnswered).toEqual(["contrast", "occludedFraction"]);
  });

  test("a read that answered everything it was asked for says nothing", () => {
    const reply = { ui: { status: "ok", data: { elements: [{ path: "HUD.Tally", text: "4" }] } } };
    const out = postProcess(reply, { ui: { fields: ["text"] } }) as { ui: Record<string, unknown> };
    expect(out.ui.fieldsNotAnswered).toBeUndefined();
  });

  test("does not count aggregate metadata as an element field", () => {
    const reply = {
      ui: {
        status: "ok",
        data: {
          viewport: { reachable: { x: 0.5 } },
          elements: [{ path: "HUD.Tally", text: "4" }],
        },
      },
    };
    const out = postProcess(reply, { ui: { fields: ["x"] } }) as {
      ui: { fieldsNotAnswered?: string[] };
    };
    expect(out.ui.fieldsNotAnswered).toEqual(["x"]);
  });

  test("a field answered with null counts as answered", () => {
    const reply = {
      ui: { status: "ok", data: { elements: [{ path: "HUD.Tally", text: "4", contrast: null, readable: null }] } },
    };
    const out = postProcess(reply, { ui: { fields: ["text", "contrast", "readable"] } }) as {
      ui: Record<string, unknown>;
    };
    expect(out.ui.fieldsNotAnswered).toBeUndefined();
  });

  test("a section that came back with no elements is not accused of dropping every field", () => {
    const reply = { ui: { status: "error", error: "no play test running", data: { elements: [] } } };
    const out = postProcess(reply, { ui: { fields: ["text", "readable"] } }) as { ui: Record<string, unknown> };
    expect(out.ui.fieldsNotAnswered).toBeUndefined();
  });
});

describe("game.observe arguments", () => {
  test("the array form of instances is the short way to name several", () => {
    expect(() => params.parse({ instances: ["Gate", "Glasshouse.RackA.Bed"] })).not.toThrow();
  });

  test("ui takes true or game_ui_browse's own arguments, and nothing else", () => {
    expect(() => params.parse({ ui: true })).not.toThrow();
    expect(() => params.parse({ ui: { paths: ["TallyLabel"], fields: ["text"] } })).not.toThrow();
    expect(() => params.parse({ ui: { textContains: "BLIGHTED" } })).toThrow();
  });

  test("unknown keys are rejected rather than silently ignored", () => {
    expect(() => params.parse({ screenshot: true })).toThrow();
  });
});

describe("game.observe instance selectors", () => {
  test("refuses the two selectors targets already covers", () => {
    expect(() => params.parse({ instances: { targets: ["Gate"] } })).not.toThrow();
    expect(() => params.parse({ instances: { name: "Gate" } })).toThrow();
    expect(() => params.parse({ instances: { path: "Workspace.Lane.Gate" } })).toThrow();
    expect(() => params.parse({ instances: { namePattern: "Pot", maxDepth: 4 } })).not.toThrow();
  });

  test("naming instances and searching for them are separate shapes", () => {
    expect(() => params.parse({ instances: { targets: ["Turret"] } })).not.toThrow();
    expect(() => params.parse({ instances: { targets: ["Turret"], properties: true } })).not.toThrow();
    expect(() => params.parse({ instances: { namePattern: "Turret", under: "Lane" } })).not.toThrow();
    expect(() => params.parse({ instances: { namePattern: "Pot", maxDepth: 4 } })).not.toThrow();
    expect(() => params.parse({ instances: { targets: ["Turret"], namePattern: "Turret" } })).toThrow();
    expect(() => params.parse({ instances: { targets: ["Lane"], maxDepth: 3 } })).toThrow();
    expect(() => params.parse({ instances: { targets: ["Lane"], under: "Workspace.Lane" } })).toThrow();
    expect(() => params.parse({ instances: ["Turret"] })).not.toThrow();
  });

  test("properties: true answers with the game's properties, not the engine's", () => {
    const args = { instances: { targets: ["DoorC1"], properties: true } };
    const reply = {
      instances: {
        status: "ok",
        data: {
          instances: [
            {
              name: "DoorC1",
              CanCollide: false,
              Shape: "Box",
              HoldDuration: 1.5,
              Color: { R: 1, G: 0, B: 0 },
              ObjectKey: 41,
              Archivable: true,
              Mobility: "Movable",
              PivotOffsetCFrame: {},
              AssemblyRootPart: "DoorC1",
              CurrentPhysicalProperties: {},
              WorldTransform: {},
              UnitExtent: {},
              BrickColor: "Really red",
            },
          ],
        },
      },
    };
    const out = postProcess(reply, args) as { instances: { instances: Record<string, unknown>[] } };
    const entry = out.instances.instances[0];
    expect(entry).toEqual({
      name: "DoorC1",
      CanCollide: false,
      Shape: "Box",
      HoldDuration: 1.5,
      Color: { R: 1, G: 0, B: 0 },
    });
    const plain = postProcess(reply, { instances: { targets: ["DoorC1"] } }) as {
      instances: { instances: Record<string, unknown>[] };
    };
    expect(plain.instances.instances[0].ObjectKey).toBe(41);
  });

  test("instances: true lists the top level, the way ui: true reads all of it", () => {
    expect(() => params.parse({ instances: true })).not.toThrow();
    expect(normalizeArgs({ instances: true })).toEqual({ instances: {} });
    expect(normalizeArgs({ instances: true, fields: ["Color"] })).toEqual({
      instances: { fields: ["Color"] },
      fields: ["Color"],
    });
  });

  test("fields is declared once and reaches either shape of instances", () => {
    expect(normalizeArgs({ instances: ["Gate"], fields: ["CFrame"] })).toEqual({
      instances: ["Gate"],
      fields: ["CFrame"],
    });
    expect(normalizeArgs({ instances: { targets: ["Gate"] }, fields: ["CFrame"] })).toEqual({
      instances: { targets: ["Gate"], fields: ["CFrame"] },
      fields: ["CFrame"],
    });
    expect(() => params.parse({ instances: { targets: ["Gate"], fields: ["CFrame"] } })).toThrow();
  });

  test("reading the character and instances together answers how far apart they are", () => {
    const reply = {
      atFrame: 10,
      character: {
        status: "ok",
        data: { character: { CFrame: { Position: { X: 23.44, Y: 84.15, Z: 127.74 } } } },
      },
      instances: {
        status: "ok",
        data: {
          instances: [
            {
              name: "ExitGate",
              CFrame: { Position: { X: 0, Y: 65, Z: 280 } },
              Size: { X: 220, Y: 130, Z: 35 },
            },
            { name: "Stations", class: "Model" },
          ],
        },
      },
      requestedSections: ["character", "instances"],
    };

    const out = postProcess(reply) as {
      instances: { instances: Record<string, unknown>[] };
    };
    const [gate, model] = out.instances.instances;
    expect(gate.distanceFromCharacter).toBeCloseTo(134.8, 1);
    expect(model.distanceFromCharacter).toBeUndefined();
  });

  test("no character section means no distances, rather than distances from nowhere", () => {
    const reply = {
      instances: {
        status: "ok",
        data: {
          instances: [{ name: "Pad", CFrame: { Position: { X: 0, Y: 2, Z: -700 } }, Size: { X: 240, Y: 4, Z: 240 } }],
        },
      },
      requestedSections: ["instances"],
    };
    const out = postProcess(reply) as { instances: { instances: Record<string, unknown>[] } };
    expect(out.instances.instances[0].distanceFromCharacter).toBeUndefined();
  });

  test("a placeholder filter in the section is dropped, as it is on the single read", () => {
    expect(normalizeArgs({ instances: { namePattern: ".", class: ".", maxDepth: 1 } })).toEqual({
      instances: { maxDepth: 1 },
    });
    expect(normalizeArgs({ instances: { namePattern: ".", maxDepth: 1 }, fields: ["CFrame"] })).toEqual({
      instances: { maxDepth: 1, fields: ["CFrame"] },
      fields: ["CFrame"],
    });
    expect(normalizeArgs({ instances: { namePattern: "Pot" } })).toEqual({ instances: { namePattern: "Pot" } });
    expect(normalizeArgs({ instances: ["Gate"] })).toEqual({ instances: ["Gate"] });
  });
});
