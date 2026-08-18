// @summary Treats an empty value on an optional parameter as the parameter not being given.
import type { z } from "zod";

/**
 * A model cannot leave out a parameter it has already decided to think about. Where it has no
 * value it writes one that means "nothing" — `""`, `[]`, `{}`, `null` — and `z.string().optional()`
 * accepts every one of them, so the empty string travels on as if it were an answer. Studio then
 * refuses a play-test client whose id is "".
 *
 * Only optional keys are dropped. `""` on a required parameter is a real value: it is the
 * replacement text that deletes a line.
 *
 * An empty *array* is dropped too, which is a reversal worth stating. The argument for keeping it
 * was that `[]` can be a deliberate "none of them" — true of a caller who could have omitted the
 * parameter and chose not to. This caller cannot omit, so for it `[]` is a blank like the others,
 * and both measured cases were exactly that: `paths: []` and `fields: []` on a call that wanted
 * the whole HUD. Entries *inside* an array are never touched — editing a list the caller wrote is
 * reading a different request than the one sent.
 */
export function dropEmptyOptionals(schema: z.ZodTypeAny, input: unknown): unknown {
  const shape = objectShape(schema);
  if (!shape || !isPlainObject(input)) return input;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const field = shape[key];
    if (!field) {
      out[key] = value; // Unknown to the schema — let validation have its say.
      continue;
    }
    const cleaned = dropEmptyOptionals(field, value);
    if (isEmpty(cleaned) && isOptional(field)) continue;
    out[key] = cleaned;
  }
  return out;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptional(schema: z.ZodTypeAny): boolean {
  try {
    return schema.isOptional();
  } catch {
    return false;
  }
}

/**
 * The shape of the object this schema describes, looking through the wrappers a parameter picks up
 * on the way to being declared — `.optional()`, `.default()`, `.preprocess()`. Matched by typeName
 * rather than instanceof so a second copy of zod in the tree does not silently disable this.
 */
function objectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | undefined {
  let current = schema as { _def?: Record<string, unknown> } | undefined;
  for (let depth = 0; current?._def && depth < 10; depth += 1) {
    const def = current._def as { typeName?: string; innerType?: unknown; schema?: unknown; options?: unknown };
    if (def.typeName === "ZodObject") {
      const shape = (current as unknown as z.ZodObject<z.ZodRawShape>).shape;
      return shape as Record<string, z.ZodTypeAny>;
    }
    // A parameter offered in two shapes — an object or a shorthand for it, which is how one
    // question stops being two parameters. Only an unambiguous object branch is followed; with
    // several, which one was meant is a guess, and guessing here edits the caller's request.
    if (Array.isArray(def.options)) {
      const objects = (def.options as z.ZodTypeAny[]).filter((option) => objectShape(option) !== undefined);
      return objects.length === 1 ? objectShape(objects[0]) : undefined;
    }
    const inner = def.innerType ?? def.schema;
    if (!inner) return undefined;
    current = inner as { _def?: Record<string, unknown> };
  }
  return undefined;
}
