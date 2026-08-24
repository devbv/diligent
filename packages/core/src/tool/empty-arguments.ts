// @summary Treats an empty value on an optional parameter as the parameter not being given.
import type { z } from "zod";
export function dropEmptyOptionals(schema: z.ZodTypeAny, input: unknown): unknown {
  const shape = objectShape(schema, input);
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
function isStrictObject(schema: z.ZodTypeAny): boolean {
  let current = schema as { _def?: Record<string, unknown> } | undefined;
  for (let depth = 0; current?._def && depth < 10; depth += 1) {
    const def = current._def as { typeName?: string; unknownKeys?: string; innerType?: unknown; schema?: unknown };
    if (def.typeName === "ZodObject") return def.unknownKeys === "strict";
    const inner = def.innerType ?? def.schema;
    if (!inner) return false;
    current = inner as { _def?: Record<string, unknown> };
  }
  return false;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  try {
    return schema.isOptional();
  } catch {
    return false;
  }
}

/** Unwraps Zod wrappers and selects a strict union branch only when input keys identify exactly one. */
function objectShape(schema: z.ZodTypeAny, input: unknown): Record<string, z.ZodTypeAny> | undefined {
  let current = schema as { _def?: Record<string, unknown> } | undefined;
  for (let depth = 0; current?._def && depth < 10; depth += 1) {
    const def = current._def as { typeName?: string; innerType?: unknown; schema?: unknown; options?: unknown };
    if (def.typeName === "ZodObject") {
      const shape = (current as unknown as z.ZodObject<z.ZodRawShape>).shape;
      return shape as Record<string, z.ZodTypeAny>;
    }
    if (Array.isArray(def.options)) {
      const branches = (def.options as z.ZodTypeAny[])
        .map((option) => ({ option, shape: objectShape(option, input) }))
        .filter((branch): branch is { option: z.ZodTypeAny; shape: Record<string, z.ZodTypeAny> } => {
          return branch.shape !== undefined;
        });
      if (branches.length === 1) return branches[0].shape;
      if (!isPlainObject(input) || !branches.every((branch) => isStrictObject(branch.option))) return undefined;
      const keys = Object.keys(input);
      const fits = branches.filter((branch) => keys.every((key) => key in branch.shape));
      return fits.length === 1 ? fits[0].shape : undefined;
    }
    const inner = def.innerType ?? def.schema;
    if (!inner) return undefined;
    current = inner as { _def?: Record<string, unknown> };
  }
  return undefined;
}
