// @summary Tags structured property values with the ObjectType the RPC requires.

/**
 * The tool schemas keep structured values bare — a CFrame is `{Position, Orientation}`
 * and a Vector3 is `{X, Y, Z}`. Writing those into the .ovdrjm works because the file
 * parser infers the type from the property, but `instance.create` / `instance.update`
 * reject them: "Property CFrame expects LuaCFrame ... but received Position : Object".
 * The tag is added here, keyed by the exact set of members, matching how Studio itself
 * serialises them.
 */
const OBJECT_TYPES: { type: string; keys: string[] }[] = [
  { type: "CFrame", keys: ["Orientation", "Position"] },
  { type: "Vector3", keys: ["X", "Y", "Z"] },
  { type: "Color3", keys: ["B", "G", "R"] },
  { type: "PhysicalProperties", keys: ["Density", "Elasticity", "Friction"] },
  { type: "BrickColor", keys: ["Name", "Number", "b", "g", "r"] },
];

function objectTypeFor(value: Record<string, unknown>): string | undefined {
  const keys = Object.keys(value).sort();
  return OBJECT_TYPES.find((c) => c.keys.length === keys.length && c.keys.every((k, i) => k === keys[i]))?.type;
}

/** Adds ObjectType to every structured value that needs one. Values already tagged are left alone. */
export function tagObjectTypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(tagObjectTypes);
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const tagged: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) tagged[key] = tagObjectTypes(child);

  if (typeof source.ObjectType === "string") return tagged;
  const type = objectTypeFor(source);
  return type ? { ObjectType: type, ...tagged } : tagged;
}
