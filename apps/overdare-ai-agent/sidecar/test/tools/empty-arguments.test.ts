// @summary Tests the blank-argument rule against the real Studio tool schemas it was written for.
import { describe, expect, test } from "bun:test";
import { dropEmptyOptionals } from "@diligent/core/tool-contract";
import { params as characterReadParams } from "../../src/tools/studiorpc/methods/game.character.read";
import { params as instanceReadParams } from "../../src/tools/studiorpc/methods/game.instance.read";
import { params as observeParams } from "../../src/tools/studiorpc/methods/game.observe";
import { params as screenshotParams } from "../../src/tools/studiorpc/methods/game.screenshot";

/**
 * The rule itself is tested in packages/core; these are the calls that motivated it, checked
 * against the schemas they were actually sent to. Both boundaries now use the same function —
 * the agent's tool loop and the MCP router — where the router used to drop every empty string
 * regardless of the schema, which would have taken a script edit's `newText: ""` with it.
 */
describe("what a caller with no value to give sends", () => {
  test("a play-test client it does not know yet", () => {
    // Verbatim from the first game_character_read of a thread. Studio answered
    // "That play-test client cannot be read."
    expect(dropEmptyOptionals(characterReadParams, { pieSessionId: "", clientId: "" })).toEqual({});
    // And the half-known case: one id it has, one it does not.
    expect(dropEmptyOptionals(characterReadParams, { pieSessionId: "377e372c", clientId: "" })).toEqual({
      pieSessionId: "377e372c",
    });
  });

  test("every filter on a call that wanted the top level", () => {
    // The `.` values are handled separately, by game.instance.read's own placeholder rule —
    // they are not empty, and only that tool knows an instance name cannot be punctuation.
    expect(dropEmptyOptionals(instanceReadParams, { maxDepth: 1, fields: [], namePattern: "" })).toEqual({
      maxDepth: 1,
    });
    // The same call written as an observe section, where the blanks nest one level down.
    expect(dropEmptyOptionals(observeParams, { instances: { maxDepth: 1, namePattern: "" }, character: true })).toEqual(
      { instances: { maxDepth: 1 }, character: true },
    );
  });

  test("a camera it did not want to move", () => {
    // Declaring the placement as one object is what stops half of it arriving; clearing it when
    // both halves are blank is what stops none of it arriving as something.
    expect(dropEmptyOptionals(screenshotParams, { includeGui: true, camera: {} })).toEqual({ includeGui: true });
  });

  test("a list it wrote is never edited, only dropped whole", () => {
    // `locate` takes names and points together. Removing entries from it would be answering a
    // different request; an empty list is the blank, an entry is the caller's own data.
    expect(dropEmptyOptionals(screenshotParams, { locate: ["Gate", { x: 0, y: 0, z: 0 }] })).toEqual({
      locate: ["Gate", { x: 0, y: 0, z: 0 }],
    });
    expect(dropEmptyOptionals(screenshotParams, { locate: [], includeGui: false })).toEqual({ includeGui: false });
  });

  test("zero and false are answers, not blanks", () => {
    expect(dropEmptyOptionals(screenshotParams, { includeGui: false })).toEqual({ includeGui: false });
    expect(dropEmptyOptionals(instanceReadParams, { maxDepth: 0 })).toEqual({ maxDepth: 0 });
  });
});
