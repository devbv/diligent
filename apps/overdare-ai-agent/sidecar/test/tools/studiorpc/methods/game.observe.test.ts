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

  // The `data` wrapper existed only to keep each section byte-identical to a single tool that
  // could also be called on its own. Those tools are gone, so the depth buys nothing.
  test("a section's own fields sit on the section, not under data", () => {
    const out = postProcess(reply()) as Record<string, Record<string, unknown>>;

    expect(out.instances.data).toBeUndefined();
    expect(out.instances.status).toBe("ok");
    expect(Array.isArray(out.instances.instances)).toBe(true);
    // `success` said what `status` says. Two verdict fields is a reply where the reader picks one.
    expect(out.instances.success).toBeUndefined();
    // The character payload's only content was another `character`, so it is hoisted twice.
    expect(out.character.character).toBeUndefined();
    expect(out.character.data).toBeUndefined();
    expect(out.character.status).toBe("ok");
    // The verdict comes first. A section's status printed after a 178-entry listing is a
    // status nobody reads, which is the same as not having one.
    expect(Object.keys(out.instances)[0]).toBe("status");
  });

  test("a payload cannot overwrite the word that describes the read", () => {
    // `status` says how the section itself went. A payload carrying its own would be answering
    // a different question under the same name, and the reader cannot tell.
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
    // newgame4 asked a HUD for readable, contrast, occludedBy and occludedFraction and got text,
    // visibility, position and colour. Nothing said the other four had not been answered, so
    // "absent" and "empty" looked the same and the reader had to guess which it was.
    const reply = {
      ui: {
        status: "ok",
        data: { elements: [{ path: "HUD.Tally", Text: "4", Visible: true, readable: true }] },
      },
    };
    const out = postProcess(reply, { ui: { fields: ["Text", "readable", "contrast", "occludedFraction"] } }) as {
      ui: { fieldsNotAnswered?: string[] };
    };

    // Matched without case: `Text` was asked for in that spelling and came back in it.
    expect(out.ui.fieldsNotAnswered).toEqual(["contrast", "occludedFraction"]);
  });

  test("a read that answered everything it was asked for says nothing", () => {
    const reply = { ui: { status: "ok", data: { elements: [{ path: "HUD.Tally", text: "4" }] } } };
    const out = postProcess(reply, { ui: { fields: ["text"] } }) as { ui: Record<string, unknown> };
    expect(out.ui.fieldsNotAnswered).toBeUndefined();
  });

  test("a section that came back with no elements is not accused of dropping every field", () => {
    // The section's own status and error describe a read that did not happen. Listing all four
    // fields as unanswered on top of that is noise dressed as a finding.
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
    // Measured on gpt-5.6-terra: the first observe call of a run carried targets, name, path and
    // namePattern together. `targets` takes a name or a dot-separated path, one entry each, so
    // the other two said nothing it could not — and being offered, they were filled.
    expect(() => params.parse({ instances: { targets: ["Gate"] } })).not.toThrow();
    expect(() => params.parse({ instances: { name: "Gate" } })).toThrow();
    expect(() => params.parse({ instances: { path: "Workspace.Lane.Gate" } })).toThrow();
    // Searching and listing stay: they answer a question `targets` cannot.
    expect(() => params.parse({ instances: { namePattern: "Pot", maxDepth: 4 } })).not.toThrow();
  });

  test("naming instances and searching for them are separate shapes", () => {
    // Ten of eleven reports in one round named the mixed object as the parameter that earned
    // nothing, and four raised it again as a defect. Resolving it after the fact was the second
    // attempt; refusing it was the first, and playtest10 measured what that did — the same call
    // three times, first with four real paths beside namePattern "Pot", then with the search
    // values replaced by "x", then with targets replaced by ["X"]. Offered a parameter the agent
    // fills it. Two shapes give it somewhere to put nothing.
    expect(() => params.parse({ instances: { targets: ["Turret"] } })).not.toThrow();
    expect(() => params.parse({ instances: { targets: ["Turret"], properties: true } })).not.toThrow();
    expect(() => params.parse({ instances: { namePattern: "Turret", under: "Lane" } })).not.toThrow();
    expect(() => params.parse({ instances: { namePattern: "Pot", maxDepth: 4 } })).not.toThrow();
    // Mixing them is now unspellable rather than silently half-answered.
    expect(() => params.parse({ instances: { targets: ["Turret"], namePattern: "Turret" } })).toThrow();
    expect(() => params.parse({ instances: { targets: ["Lane"], maxDepth: 3 } })).toThrow();
    expect(() => params.parse({ instances: { targets: ["Lane"], under: "Workspace.Lane" } })).toThrow();
    // The array shorthand is `targets` by another name, so it cannot carry a search either —
    // there is nowhere in it to put one.
    expect(() => params.parse({ instances: ["Turret"] })).not.toThrow();
  });

  test("properties: true answers with the game's properties, not the engine's", () => {
    // Every report in the round listed the same fields as read-past noise. They are the
    // serializer's view of an actor; a reader asking whether a door is open wants CanCollide.
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

    // What the game is made of survives, including the properties this flag exists to reach.
    expect(entry).toEqual({
      name: "DoorC1",
      CanCollide: false,
      Shape: "Box",
      HoldDuration: 1.5,
      Color: { R: 1, G: 0, B: 0 },
    });

    // Without the flag there is no dump to strip, and nothing is touched.
    const plain = postProcess(reply, { instances: { targets: ["DoorC1"] } }) as {
      instances: { instances: Record<string, unknown>[] };
    };
    expect(plain.instances.instances[0].ObjectKey).toBe(41);
  });

  test("instances: true lists the top level, the way ui: true reads all of it", () => {
    // The starting move of a run that does not know any names yet. It cannot be spelled `{}`:
    // an empty object is a blank, blanks are dropped before the call is built, and the section
    // would disappear — leaving the caller rejected for asking for nothing.
    expect(() => params.parse({ instances: true })).not.toThrow();
    expect(normalizeArgs({ instances: true })).toEqual({ instances: {} });
    expect(normalizeArgs({ instances: true, fields: ["Color"] })).toEqual({
      instances: { fields: ["Color"] },
      fields: ["Color"],
    });
  });

  test("fields is declared once and reaches either shape of instances", () => {
    // It used to apply to the array form and be ignored beside the object form, in silence.
    expect(normalizeArgs({ instances: ["Gate"], fields: ["CFrame"] })).toEqual({
      instances: ["Gate"],
      fields: ["CFrame"],
    });
    expect(normalizeArgs({ instances: { targets: ["Gate"] }, fields: ["CFrame"] })).toEqual({
      instances: { targets: ["Gate"], fields: ["CFrame"] },
      fields: ["CFrame"],
    });
    // The section can no longer declare its own, so there is nothing to conflict with.
    expect(() => params.parse({ instances: { targets: ["Gate"], fields: ["CFrame"] } })).toThrow();
  });

  test("reading the character and instances together answers how far apart they are", () => {
    // Verbatim from the playtest12 run that reported two range violations that were not there.
    // The tester measured to the Exit Gate's centre — 155.2 — against a stated reach of 140, and
    // could not explain the gap. The gap is the gate's own 35-unit depth: 134.8 to its surface,
    // which is inside 140, which is why the game accepted it.
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
            // A Model has no size and nothing to measure to; it is passed through untouched.
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
    // The section takes game.instance.read's identifier parameters, so it inherits the caller
    // that fills them with "." rather than leave them out — and a namePattern of "." matches
    // every nested path, which is the whole world rather than the maxDepth asked for.
    expect(normalizeArgs({ instances: { namePattern: ".", class: ".", maxDepth: 1 } })).toEqual({
      instances: { maxDepth: 1 },
    });
    expect(normalizeArgs({ instances: { namePattern: ".", maxDepth: 1 }, fields: ["CFrame"] })).toEqual({
      instances: { maxDepth: 1, fields: ["CFrame"] },
      fields: ["CFrame"],
    });
    // A real filter is untouched, and so is the array shorthand, which carries no filters.
    expect(normalizeArgs({ instances: { namePattern: "Pot" } })).toEqual({ instances: { namePattern: "Pot" } });
    expect(normalizeArgs({ instances: ["Gate"] })).toEqual({ instances: ["Gate"] });
  });
});
