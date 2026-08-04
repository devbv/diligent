// @summary Tests that every advertised tool schema is an object schema, whatever Zod produced
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { toToolInputSchema } from "../../src/tool/input-schema";

describe("toToolInputSchema", () => {
  test("passes an object-shaped Zod schema through with its type intact", () => {
    const schema = toToolInputSchema({
      parameters: z.object({ filePath: z.string() }).strict(),
    });

    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({ filePath: { type: "string" } });
  });

  test("tags a top-level discriminated union as an object without merging its branches", () => {
    const schema = toToolInputSchema({
      parameters: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("a"), a: z.string() }).strict(),
        z.object({ kind: z.literal("b"), b: z.number() }).strict(),
      ]),
    });

    // Anthropic rejects the request outright when `type` is missing on a tool input schema.
    expect(schema.type).toBe("object");
    expect(Array.isArray(schema.anyOf)).toBe(true);
    expect((schema.anyOf as unknown[]).length).toBe(2);
  });

  test("tags a top-level plain union as an object", () => {
    const schema = toToolInputSchema({
      parameters: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
    });

    expect(schema.type).toBe("object");
  });

  test("drops the $schema keyword that providers do not accept", () => {
    const schema = toToolInputSchema({ parameters: z.object({}).strict() });

    expect(schema.$schema).toBeUndefined();
  });

  test("prefers a raw inputSchema over the Zod parameters", () => {
    const schema = toToolInputSchema({
      parameters: z.object({ ignored: z.string() }),
      inputSchema: { type: "object", properties: { fromMcp: { type: "string" } } },
    });

    expect(schema.properties).toEqual({ fromMcp: { type: "string" } });
  });

  test("tags a raw inputSchema that arrives without a type", () => {
    const schema = toToolInputSchema({
      parameters: z.object({}),
      inputSchema: { properties: { a: { type: "string" } } },
    });

    expect(schema.type).toBe("object");
  });
});
