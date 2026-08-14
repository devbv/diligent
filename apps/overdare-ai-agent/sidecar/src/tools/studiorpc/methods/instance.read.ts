import { z } from "zod";

export const method = "instance.read";

export const description =
  "Read instance properties from the level file by GUID. Returns only known class properties. Use recursive to include descendants.";

export const params = z.object({
  guid: z
    .string()
    .describe(
      "GUID of the instance to read. Tools that report a GUID name it instanceGuid; pass that same value here.",
    ),
  recursive: z.boolean().describe("If true, include all descendants recursively").default(false),
});

/** Accepts instanceGuid, the name every tool that reports a GUID uses, as guid. */
export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (args.guid === undefined && typeof args.instanceGuid === "string") {
    const { instanceGuid, ...rest } = args;
    return { ...rest, guid: instanceGuid };
  }
  return args;
}
