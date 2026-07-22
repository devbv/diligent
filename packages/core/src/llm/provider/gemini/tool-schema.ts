// @summary Normalizes oversized function schemas for Gemini native-tool compatibility.

const DEFAULT_MAX_SCHEMA_BYTES = 32_000;

type JsonSchema = Record<string, unknown>;

interface SchemaVariant {
  schema: JsonSchema;
  context?: string;
}

export function normalizeGeminiToolSchema(schema: JsonSchema, maxSchemaBytes = DEFAULT_MAX_SCHEMA_BYTES): JsonSchema {
  if (JSON.stringify(schema).length <= maxSchemaBytes) return schema;
  const normalized = simplifySchema(dereferenceSchema(schema, schema, new Set()));
  return isRecord(normalized) ? normalized : schema;
}

function dereferenceSchema(value: unknown, root: JsonSchema, resolvingRefs: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => dereferenceSchema(entry, root, resolvingRefs));
  }
  if (!isRecord(value)) return value;

  const ref = typeof value.$ref === "string" ? value.$ref : undefined;
  if (ref?.startsWith("#/")) {
    if (resolvingRefs.has(ref)) return {};
    const target = resolveJsonPointer(root, ref);
    if (target !== undefined) {
      const nextRefs = new Set(resolvingRefs).add(ref);
      const { $ref, ...siblings } = value;
      const dereferenced = dereferenceSchema(target, root, nextRefs);
      if (isRecord(dereferenced)) {
        return dereferenceSchema({ ...dereferenced, ...siblings }, root, nextRefs);
      }
      return dereferenced;
    }
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$defs" && key !== "definitions" && key !== "$schema")
      .map(([key, entry]) => [key, dereferenceSchema(entry, root, resolvingRefs)]),
  );
}

function resolveJsonPointer(root: JsonSchema, ref: string): unknown {
  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function simplifySchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(simplifySchema);
  if (!isRecord(value)) return value;

  const simplified = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, simplifySchema(entry)]));
  const anyOf = Array.isArray(simplified.anyOf)
    ? simplified.anyOf.filter((variant) => !isImpossibleSchema(variant))
    : undefined;
  if (!anyOf || anyOf.length === 0) return simplified;

  const variants = deduplicateSchemas(anyOf);
  if (variants.length === 1) {
    const { anyOf: _anyOf, ...siblings } = simplified;
    return isRecord(variants[0]) ? { ...variants[0], ...siblings } : variants[0];
  }
  if (variants.every(isObjectSchema)) {
    const { anyOf: _anyOf, ...siblings } = simplified;
    return { ...mergeObjectSchemas(variants as JsonSchema[]), ...siblings };
  }
  return { ...simplified, anyOf: variants };
}

function mergeObjectSchemas(schemas: JsonSchema[]): JsonSchema {
  const variantsByProperty = new Map<string, SchemaVariant[]>();

  for (const schema of schemas) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const context = typeof schema.description === "string" ? schema.description : undefined;
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      if (!isRecord(propertySchema)) continue;
      const variants = variantsByProperty.get(propertyName) ?? [];
      variants.push({ schema: propertySchema, context });
      variantsByProperty.set(propertyName, variants);
    }
  }

  const properties = Object.fromEntries(
    [...variantsByProperty].map(([propertyName, variants]) => [propertyName, mergePropertyVariants(variants)]),
  );
  const requiredSets = schemas.map((schema) => new Set(Array.isArray(schema.required) ? schema.required : []));
  const required = [...(requiredSets[0] ?? [])].filter((name) => requiredSets.every((set) => set.has(name)));

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(schemas.every((schema) => schema.additionalProperties === false) ? { additionalProperties: false } : {}),
  };
}

function mergePropertyVariants(variants: SchemaVariant[]): JsonSchema {
  const unique = new Map<string, SchemaVariant>();
  for (const variant of variants) {
    const fingerprint = JSON.stringify(variant.schema);
    const existing = unique.get(fingerprint);
    if (!existing) {
      unique.set(fingerprint, { ...variant });
    } else if (variant.context && existing.context !== variant.context) {
      existing.context = [existing.context, variant.context].filter(Boolean).join(" ");
    }
  }

  const entries = [...unique.values()];
  if (entries.length === 1) return entries[0]!.schema;
  return {
    anyOf: entries.map(({ schema, context }) =>
      context
        ? {
            ...schema,
            description: `${context}${typeof schema.description === "string" ? ` ${schema.description}` : ""}`,
          }
        : schema,
    ),
    description: "The accepted value shape depends on the selected object variant.",
  };
}

function deduplicateSchemas(values: unknown[]): unknown[] {
  const unique = new Map<string, unknown>();
  for (const value of values) unique.set(JSON.stringify(value), value);
  return [...unique.values()];
}

function isObjectSchema(value: unknown): value is JsonSchema {
  return isRecord(value) && (value.type === "object" || isRecord(value.properties));
}

function isImpossibleSchema(value: unknown): boolean {
  return isRecord(value) && isRecord(value.not) && Object.keys(value.not).length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
