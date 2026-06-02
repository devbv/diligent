import { z } from "zod";

export const method = "instance.read";

export const description =
  "Read instance properties from the level file by GUID. Returns only known class properties. Use recursive to include descendants.";

export const params = z.object({
  guid: z.string().describe("GUID of the instance to read"),
  recursive: z.boolean().describe("If true, include all descendants recursively").default(false),
});
