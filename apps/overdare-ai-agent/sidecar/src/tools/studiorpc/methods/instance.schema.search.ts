// @summary Read-only Studio RPC lookup for writable instance property hints, sourced from the live Studio build.

import { z } from "zod";

export const method = "instance.schema.search";

export const description =
  "Search the running Studio build for instance properties you are allowed to write. Give a query (case-insensitive substring matched against class and property names), a list of exact class names, or both. Returns each match as class + property name + a JSON Schema hint for the value, along with whether the class is creatable or a service. Only externally writable properties that the instance JSON serializer actually accepts are returned, so the names are safe to use as studiorpc_instance_upsert property keys. Read-only: it never changes the level. Page with nextCursor.";

export const params = z
  .object({
    query: z
      .string()
      .min(1)
      .optional()
      .describe('Case-insensitive substring matched against class and property names, e.g. "color".'),
    classes: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe('Exact instance type names to search, e.g. ["Part", "TextLabel"]. Max 20.'),
    limit: z.number().int().min(1).max(100).default(50).describe("Maximum matches to return (1-100)."),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe("Opaque nextCursor from a previous call. Only valid for the same query and classes."),
  })
  .strict()
  .refine((value) => value.query !== undefined || value.classes !== undefined, {
    message: "query or classes is required",
  });
