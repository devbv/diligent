// @summary Tests what the live instance read takes, and what it deliberately no longer takes.
import { describe, expect, test } from "bun:test";
import {
  namesNothing,
  normalizeArgs,
  params,
  recover,
  stripWorkspacePrefix,
} from "../../../../src/tools/studiorpc/methods/game.instance.read";

describe("game.instance.read arguments", () => {
  test("takes one word for which instance, in either spelling, and no arguments at all", () => {
    expect(() => params.parse({ target: "Gate" })).not.toThrow();
    expect(() => params.parse({ target: "Lane.Gate" })).not.toThrow();
    expect(() => params.parse({})).not.toThrow();
    // `name` and `path` were two parameters for one question, which is the shape an agent
    // answers twice and inconsistently. Studio still takes both; this tool decides which.
    expect(() => params.parse({ name: "Gate" })).toThrow();
    expect(() => params.parse({ path: "Lane.Gate" })).toThrow();
    expect(normalizeArgs({ target: "Gate" })).toEqual({ name: "Gate" });
    expect(normalizeArgs({ target: "Lane.Gate" })).toEqual({ path: "Lane.Gate" });
  });

  test("refuses a GUID, which the running world does not identify things by", () => {
    // Both spellings were carried for the authored tool's sake and never used against
    // a running game in 77 runs.
    expect(() => params.parse({ guid: "87979D270CFA5340AC20E34C29E8C092" })).toThrow();
    expect(() => params.parse({ instanceGuid: "87979D270CFA5340AC20E34C29E8C092" })).toThrow();
  });

  test("refuses to be given one question twice, in two spellings", () => {
    // Measured on playtest3: `target: "Turret"` beside `namePattern: "Turret"`. Both reached
    // Studio, which answered the name and dropped the pattern, so the run was told nothing is
    // called Turret — in a world holding TurretLeft, TurretMid and TurretRight.
    expect(() => params.parse({ target: "Turret", namePattern: "Turret" })).toThrow(/two questions/);
    expect(() => params.parse({ target: "Turret", class: "Part" })).toThrow(/two questions/);
    // Each on its own is the whole point of the tool.
    expect(() => params.parse({ target: "Turret" })).not.toThrow();
    expect(() => params.parse({ namePattern: "Turret" })).not.toThrow();
    // And `target` with maxDepth is documented as listing that branch, so it stays legal.
    expect(() => params.parse({ target: "Lane", maxDepth: 3 })).not.toThrow();
  });

  test("refuses a batch, because studiorpc_game_observe is where batching lives", () => {
    // `targets` here and observe's `instances` were two spellings of one thing.
    expect(() => params.parse({ targets: ["Gate", "Lever"] })).toThrow();
  });
});

describe("game.instance.read on a name that is not there", () => {
  // Verbatim from the wire: the transport appends the request envelope to every error.
  const missing = new Error(
    'Studio RPC error [-32150]: No instance named "TurretMid" is in the running Workspace.\n\n' +
      'Request was:\n{"jsonrpc":"2.0","id":1,"method":"game.instance.read","params":{"name":"TurretMid"}}',
  );
  const workspace = {
    instances: [
      { name: "PlinthMid" },
      { name: "TurretMID" },
      { name: "Crystal" },
      { name: "Lane" },
      { name: "Spawner" },
    ],
  };

  test("answers found: false instead of raising", async () => {
    const result = (await recover(missing, { target: "TurretMid" }, async () => workspace)) as Record<string, unknown>;

    // Run 44 used the thrown error as its "the turret is gone" signal, which made
    // every existence check an error path.
    expect(result.found).toBe(false);
    expect(result.name).toBe("TurretMid");
    // The answer carries Studio's sentence, not the JSON-RPC envelope behind it.
    expect(result.note).toContain('No instance named "TurretMid"');
    expect(result.note).not.toContain("jsonrpc");
  });

  test("offers the names that are there, nearest first", async () => {
    const result = (await recover(missing, { target: "TurretMid" }, async () => workspace)) as {
      nearestNames: string[];
      workspaceNames: string[];
    };

    // The script named it TurretMID; the level's part is PlinthMid. Neither is
    // guessable from the other, which is what cost the run several calls.
    expect(result.nearestNames[0]).toBe("TurretMID");
    // PlinthMid shares neither a prefix nor a substring with TurretMid — only the tail,
    // which is exactly what made the wrong name look right.
    expect(result.nearestNames).toContain("PlinthMid");
    expect(result.nearestNames).not.toContain("Lane");
  });

  test("still answers when the listing itself fails", async () => {
    const result = (await recover(missing, { name: "TurretMid" }, async () => {
      throw new Error("pieNotRunning");
    })) as Record<string, unknown>;

    expect(result.found).toBe(false);
    expect(result.workspaceNames).toBeUndefined();
  });

  test("rethrows anything that is not an absent instance", async () => {
    const other = new Error("Live instance state only exists while a play test runs.");
    await expect(recover(other, { target: "TurretMid" }, async () => workspace)).rejects.toThrow(/play test runs/);
  });
});

describe("what a caller writes when the description tells it to", () => {
  test("a Workspace-rooted path is accepted, because every description asks for one", () => {
    // Paths run below Workspace — `Glasshouse.RackA.Pot1` — but the descriptions call a path
    // "the route from Workspace down", and gpt-5.6-terra wrote `Workspace.PressurePump` in a
    // world whose only pump is PressurePump. The prefix is the caller agreeing with us.
    expect(stripWorkspacePrefix("Workspace.PressurePump")).toBe("PressurePump");
    expect(stripWorkspacePrefix("game.Workspace.Lane.Gate")).toBe("Lane.Gate");
    expect(stripWorkspacePrefix("workspace.Gate")).toBe("Gate");
    // An instance that is genuinely called Workspace-something keeps its name.
    expect(stripWorkspacePrefix("WorkspaceLight")).toBe("WorkspaceLight");
    expect(stripWorkspacePrefix("Gate")).toBe("Gate");
  });

  test("normalizeArgs routes the stripped target to the field Studio expects", () => {
    expect(normalizeArgs({ target: "Workspace.Lane.Gate" })).toEqual({ path: "Lane.Gate" });
    expect(normalizeArgs({ target: "Workspace.Gate" })).toEqual({ name: "Gate" });
  });

  test("a placeholder in place of a name is read as no name at all", () => {
    // Asked to list the top level, gpt-5.6-terra filled every optional it was offered rather than
    // send `{}`: `namePattern: "__none__"` on one run, `"."` on the next. The dot is the one that
    // does damage quietly — namePattern matches the path too, and every nested path has a dot, so
    // a maxDepth-1 listing came back as an 80-instance search of the whole world.
    expect(namesNothing(".")).toBe(true);
    expect(namesNothing("")).toBe(true);
    expect(namesNothing("-")).toBe(true);
    expect(namesNothing("*")).toBe(true);
    // A real name, a class, a path, and a name that is mostly punctuation but names something.
    expect(namesNothing("Gate")).toBe(false);
    expect(namesNothing("Lane.Gate")).toBe(false);
    expect(namesNothing("ProximityPrompt")).toBe(false);
    expect(namesNothing("Pot_2")).toBe(false);
    // Not a string at all is not this function's business.
    expect(namesNothing(undefined)).toBe(false);
    expect(namesNothing(1)).toBe(false);

    expect(normalizeArgs({ target: ".", namePattern: ".", class: ".", under: ".", maxDepth: 1 })).toEqual({
      maxDepth: 1,
    });
    // `__none__` has letters in it, so it is a name — an absent one, which answers found: false
    // with the names that are there. That is a recoverable answer, not a silently different call.
    expect(normalizeArgs({ namePattern: "__none__" })).toEqual({ namePattern: "__none__" });
  });
});
