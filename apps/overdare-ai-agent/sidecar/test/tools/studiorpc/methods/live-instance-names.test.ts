// @summary Tests how a live instance gets named: the prefix callers add, placeholders, near misses.
import { describe, expect, test } from "bun:test";
import {
  dropPlaceholders,
  namesNothing,
  rankNames,
  stripWorkspacePrefix,
} from "../../../../src/tools/studiorpc/methods/live-instance-names";

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

  test("the names offered beside a miss are the ones it could have meant", () => {
    // The script named it TurretMID; the level's part is PlinthMid. Neither is guessable from
    // the other, which is what cost run 44 several calls.
    const there = ["PlinthMid", "TurretMID", "Crystal", "Lane", "Spawner"];
    expect(rankNames(there, "TurretMid")[0]).toBe("TurretMID");
    expect(rankNames(there, "TurretMid")).toContain("PlinthMid");
    expect(rankNames(there, "TurretMid")).not.toContain("Lane");
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

    expect(dropPlaceholders({ namePattern: ".", class: ".", under: ".", maxDepth: 1 })).toEqual({ maxDepth: 1 });
    // `__none__` has letters in it, so it is a name — an absent one, which answers with the names
    // that are there. That is a recoverable answer, not a silently different call.
    expect(dropPlaceholders({ namePattern: "__none__" })).toEqual({ namePattern: "__none__" });
  });
});
