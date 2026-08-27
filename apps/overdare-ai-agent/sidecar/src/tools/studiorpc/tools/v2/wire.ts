// @summary Tags structured property values with the ObjectType the RPC requires.

/**
 * The tool schemas keep structured values bare — a CFrame is `{Position, Orientation}`
 * and a Vector3 is `{X, Y, Z}`. Writing those into the .ovdrjm works because the file
 * parser infers the type from the property, but `instance.create` / `instance.update`
 * reject them: "Property CFrame expects LuaCFrame ... but received Position : Object".
 * The name is the rejection's Lua type without the prefix — LuaUDim2 -> UDim2, LuaFont
 * -> Font (the property is FontFace, the type is not).
 *
 * A nested value needs its own tag: a UDim2 whose X and Y carry no UDim tag is rejected
 * with the same message the untagged UDim2 got. The shape otherwise stays as the schema
 * declares it — Rect stays flat MinX/MinY/MaxX/MaxY even though the rejection describes
 * it as "Min : Vector2, Max : Vector2". Sequences are the exception: the schema declares
 * an array of keypoints and the RPC wants that array under a Keypoints member.
 *
 * `memberKind` exists because member names alone do not identify a type. A UDim2 and a
 * Vector2 are both `{X, Y}`; only the member values tell them apart, and Studio accepts
 * the wrong tag in silence — an AnchorPoint tagged UDim2 is stored as one, with no
 * message on the response. Matching the wrong entry is therefore worse than matching
 * none, which at least fails loudly.
 *
 * Measured against Studio 2026-08-27: every entry below was accepted and read back
 * unchanged, and the untagged form of each was rejected.
 */
interface ObjectTypeSpec {
  type: string;
  keys: string[];
  optional?: string[];
  defaults?: Record<string, string>;
  memberKind?: "number" | "object";
}

const OBJECT_TYPES: ObjectTypeSpec[] = [
  { type: "CFrame", keys: ["Orientation", "Position"] },
  { type: "Vector3", keys: ["X", "Y", "Z"] },
  { type: "Color3", keys: ["B", "G", "R"] },
  { type: "PhysicalProperties", keys: ["Density", "Elasticity", "Friction"] },
  { type: "BrickColor", keys: ["Name", "Number", "b", "g", "r"] },
  { type: "UDim2", keys: ["X", "Y"], memberKind: "object" },
  { type: "Vector2", keys: ["X", "Y"], memberKind: "number" },
  { type: "UDim", keys: ["Offset", "Scale"] },
  { type: "Rect", keys: ["MaxX", "MaxY", "MinX", "MinY"] },
  { type: "NumberRange", keys: ["Max", "Min"] },
  { type: "Font", keys: ["Family"], optional: ["Style", "Weight"], defaults: { Style: "Normal", Weight: "Regular" } },
];

/** Keypoint arrays the RPC wants wrapped. `rename` maps a schema member onto the RPC's. */
interface SequenceSpec {
  type: string;
  keys: string[];
  optional?: string[];
  rename?: Record<string, string>;
}

const SEQUENCE_TYPES: SequenceSpec[] = [
  { type: "ColorSequence", keys: ["Color", "Time"], rename: { Color: "Value" } },
  { type: "NumberSequence", keys: ["Time", "Value"], optional: ["Envelope"] },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function memberKindMatches(spec: ObjectTypeSpec, value: Record<string, unknown>): boolean {
  if (!spec.memberKind) return true;
  return spec.keys.every((key) =>
    spec.memberKind === "object" ? isRecord(value[key]) : typeof value[key] === "number",
  );
}

function keysMatch(spec: { keys: string[]; optional?: string[] }, keys: string[]): boolean {
  return (
    spec.keys.every((key) => keys.includes(key)) &&
    keys.every((key) => spec.keys.includes(key) || !!spec.optional?.includes(key))
  );
}

function specFor(value: Record<string, unknown>): ObjectTypeSpec | undefined {
  const keys = Object.keys(value);
  return OBJECT_TYPES.find((spec) => keysMatch(spec, keys) && memberKindMatches(spec, value));
}

function sequenceSpecFor(items: unknown[]): SequenceSpec | undefined {
  if (items.length === 0 || !items.every(isRecord)) return undefined;
  return SEQUENCE_TYPES.find((spec) => items.every((item) => keysMatch(spec, Object.keys(item))));
}

function renameMembers(item: unknown, rename: Record<string, string> | undefined): unknown {
  if (!rename || !isRecord(item)) return item;
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [rename[key] ?? key, value]));
}

/** Adds ObjectType to every structured value that needs one. Values already tagged are left alone. */
export function tagObjectTypes(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(tagObjectTypes);
    const spec = sequenceSpecFor(value);
    if (!spec) return items;
    return { ObjectType: spec.type, Keypoints: items.map((item) => renameMembers(item, spec.rename)) };
  }
  if (!isRecord(value)) return value;

  const tagged: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) tagged[key] = tagObjectTypes(child);

  if (typeof value.ObjectType === "string") return tagged;
  const spec = specFor(value);
  return spec ? { ObjectType: spec.type, ...spec.defaults, ...tagged } : tagged;
}
