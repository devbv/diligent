// @summary Tests that observe's reply checks its own one-instant claim and keeps per-miss help.

import { describe, expect, test } from "bun:test";
import { normalizeArgs, params, postProcess } from "../../../../src/tools/studiorpc/methods/game.observe";

function reply(frames: { reply: number; character: number; instances: number }) {
  return {
    atGameTime: 41.5,
    atFrame: frames.reply,
    character: { atFrame: frames.character, status: "ok", data: { success: true, character: {} } },
    instances: {
      atFrame: frames.instances,
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

describe("game.observe keeps its one-instant claim checkable", () => {
  test("says nothing when every section came from the same frame", () => {
    const out = postProcess(reply({ reply: 8899, character: 8899, instances: 8899 })) as Record<string, unknown>;
    expect(out.sectionsSpanFrames).toBeUndefined();
    expect(out.sectionsSpanNote).toBeUndefined();
  });

  // The whole argument for this tool over three separate calls is that the readings are one
  // moment. If that ever stops being true, a run would reconcile two moments as one and nothing
  // would say so — so the reply checks itself rather than leaving it to the test suite.
  test("says so loudly when a section came from a different frame", () => {
    const out = postProcess(reply({ reply: 8899, character: 8899, instances: 8901 })) as Record<string, unknown>;
    expect(out.sectionsSpanFrames).toBe(true);
    expect(out.sectionsSpanNote).toContain("8901");
    expect(out.sectionsSpanNote).toContain("not as one moment");
  });

  test("a name that missed is still told what it probably meant", () => {
    const out = postProcess(reply({ reply: 1, character: 1, instances: 1 })) as {
      instances: { data: { instances: { query: string; nearestNames?: string[] }[] } };
    };
    const miss = out.instances.data.instances.find((entry) => entry.query === "BedZzz");
    expect(miss?.nearestNames?.[0]).toBe("Bed");
  });

  test("a reply with no instances section is left alone rather than crashed on", () => {
    const bare = { atFrame: 5, ui: { atFrame: 5, status: "ok", data: {} }, requestedSections: ["ui"] };
    expect(postProcess(bare)).toEqual(bare);
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

  test("refuses naming instances and searching for them in one section", () => {
    // studiorpc_game_instance_read refuses the same pair, and for the same reason: Studio answers
    // whichever it reads first and drops the other in silence, so the reply looks like a complete
    // answer to a question that was only half asked.
    expect(() => params.parse({ instances: { targets: ["Turret"], namePattern: "Turret" } })).toThrow(/two questions/);
    expect(() => params.parse({ instances: { targets: ["Turret"], class: "Part" } })).toThrow(/two questions/);
    // `under` narrows a search rather than competing with it, and listing depth belongs to either.
    expect(() => params.parse({ instances: { targets: ["Lane"], maxDepth: 3 } })).not.toThrow();
    expect(() => params.parse({ instances: { namePattern: "Turret", under: "Lane" } })).not.toThrow();
    // The array shorthand is `targets` by another name, so it cannot carry a search either —
    // there is nowhere in it to put one.
    expect(() => params.parse({ instances: ["Turret"] })).not.toThrow();
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
      instances: { data: { instances: Record<string, unknown>[]; distanceNote?: string } };
    };
    const [gate, model] = out.instances.data.instances;
    expect(gate.distanceFromCharacter).toBeCloseTo(134.8, 1);
    expect(gate.horizontalDistanceToCentre).toBeCloseTo(154.1, 1);
    expect(model.distanceFromCharacter).toBeUndefined();
    expect(out.instances.data.distanceNote).toContain("surface");
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
    const out = postProcess(reply) as { instances: { data: { instances: Record<string, unknown>[] } } };
    expect(out.instances.data.instances[0].distanceFromCharacter).toBeUndefined();
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
