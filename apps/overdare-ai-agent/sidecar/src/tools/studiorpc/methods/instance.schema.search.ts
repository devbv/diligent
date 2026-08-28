// @summary Read-only Studio RPC lookup for writable instance property hints, sourced from the live Studio build.

import { z } from "zod";

export const method = "instance.schema.search";

export const description =
  "Search the running Studio build for instance properties you are allowed to write. Give a query (case-insensitive substring matched against class and property names), a list of exact class names, or both. Returns matching classes with their writable properties grouped in a properties array, plus whether each class is creatable or a service. Only externally writable properties that the instance JSON serializer actually accepts are returned, so the names are safe to use as studiorpc_instance_upsert property keys. Read-only: it never changes the level.";

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
  })
  .strict()
  .refine((value) => value.query !== undefined || value.classes !== undefined, {
    message: "query or classes is required",
  });
