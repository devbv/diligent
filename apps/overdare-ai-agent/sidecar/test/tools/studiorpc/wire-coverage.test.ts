// @summary Pins every structured value the instance schema declares to what wire.ts does with it.

import { describe, expect, test } from "bun:test";
import { classPropertyShapes, type ShapeSpec } from "../../../src/tools/studiorpc/methods/instance.params";
import { tagObjectTypes } from "../../../src/tools/studiorpc/tools/v2/wire";

/**
 * instance.create rejects a structured value carrying no ObjectType, and wire.ts holds the
 * table that supplies one. That table repeats what the schema already knows, and nothing
 * makes the two move together: every gap so far — UDim2, UDim, Rect, Font, NumberRange —
 * reached a release because a property was added on one side only, and the comparison
 * scenarios never built an instance that used it.
 *
 * So the schema is walked here instead of trusted. A new structured value shows up as a
 * signature this table does not list, and the author has to say what it is. Answering
 * "untagged" is allowed — several shapes are configuration rather than an engine type —
 * but it has to be answered.
 */

/** `X:number` and `X:object` are distinct: a Vector2 and a UDim2 are both `{X, Y}`. */
function signature(shape: Record<string, ShapeSpec>): string {
  return Object.keys(shape)
    .sort()
    .map((key) => `${key}:${shape[key] === true ? "number" : "object"}`)
    .join(", ");
}

/** ObjectType has to stay a string: tagObjectTypes reads it to decide a value is already tagged. */
function sampleValue(shape: Record<string, ShapeSpec>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(shape).map(([key, child]) => [
      key,
      child === true ? (key === "ObjectType" ? "AlreadyTagged" : 0) : sampleValue(child),
    ]),
  );
}

function collect(shape: ShapeSpec, path: string, into: Map<string, string>): void {
  if (shape === true) return;
  if (!into.has(signature(shape))) into.set(signature(shape), path);
  for (const child of Object.values(shape)) collect(child, path, into);
}

/** The sample value's own tag, echoed back — wire.ts left a schema-tagged value alone. */
const SCHEMA_TAGGED = "AlreadyTagged";

/**
 * Every structured value the schema declares, and the ObjectType wire.ts gives it.
 * `undefined` means it is deliberately left untagged.
 */
const EXPECTED: Record<string, string | undefined> = {
  "Orientation:object, Position:object": "CFrame",
  "X:number, Y:number, Z:number": "Vector3",
  "B:number, G:number, R:number": "Color3",
  "X:number, Y:number": "Vector2",
  "X:object, Y:object": "UDim2",
  "Offset:number, Scale:number": "UDim",
  "MaxX:number, MaxY:number, MinX:number, MinY:number": "Rect",
  "Max:number, Min:number": "NumberRange",
  "Family:number, Style:number, Weight:number": "Font",

  // Keypoints. The schema declares an array; zodToShape reports the element, so these
  // appear here as objects. tagObjectTypes wraps the array, it does not tag the element.
  "Color:object, Time:number": undefined,
  "Envelope:number, Time:number, Value:number": undefined,

  // Already carries its ObjectType in the schema — the VFXRecipe payloads are written
  // in the RPC's own spelling, so wire.ts leaves them alone.
  "B:number, G:number, ObjectType:number, R:number, Time:number": SCHEMA_TAGGED,
  "Content:number, ObjectType:number": SCHEMA_TAGGED,
  "ObjectType:number, X:number, Y:number, Z:number": SCHEMA_TAGGED,

  // Not an engine type. A VFX layer is a configuration object sent member by member.
  "Acceleration:object, Alpha:object, BoundSize:object, Color:object, Delay:number, Duration:number, FlipbookColumns:number, FlipbookMode:number, FlipbookRows:number, Lifetime_Max:number, Lifetime_Min:number, LoopDuration:number, Name:number, NiagaraSystem:number, Position:object, Rotation:object, Scale:number, Size:number, Size2D:object, SpawnCount:number, SpawnRate:number, Speed:number, Texture:object, Transparency:number":
    undefined,

  // Studio has no Color on VFXPreset — "[WARNING] Unknown property ignored" on create.
  // Tagging it would not help; the schema and Studio disagree about the property itself.
  "B:number, G:number, R:number, Time:number": undefined,
};

describe("wire.ts covers the instance schema", () => {
  const shapes = new Map<string, string>();
  for (const [cls, props] of Object.entries(classPropertyShapes)) {
    for (const [prop, shape] of Object.entries(props)) collect(shape, `${cls}.${prop}`, shapes);
  }

  test("declares no structured value the table has not been told about", () => {
    const unlisted = [...shapes].filter(([sig]) => !(sig in EXPECTED)).map(([sig, where]) => `${where}: {${sig}}`);
    expect(unlisted).toEqual([]);
  });

  test("tags each one as recorded", () => {
    const actual: Record<string, string | undefined> = {};
    for (const [sig, where] of shapes) {
      const [cls, prop] = where.split(".");
      const shape = classPropertyShapes[cls][prop];
      const found = findShape(shape, sig);
      actual[sig] = (tagObjectTypes(sampleValue(found)) as Record<string, unknown>).ObjectType as string | undefined;
    }
    expect(actual).toEqual(Object.fromEntries([...shapes.keys()].map((sig) => [sig, EXPECTED[sig]])));
  });
});

function findShape(shape: ShapeSpec, target: string): Record<string, ShapeSpec> {
  if (shape === true) throw new Error(`shape ${target} not found`);
  if (signature(shape) === target) return shape;
  for (const child of Object.values(shape)) {
    if (child === true) continue;
    try {
      return findShape(child, target);
    } catch {
      /* keep looking in the next member */
    }
  }
  throw new Error(`shape ${target} not found`);
}
