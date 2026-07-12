import { z } from "zod";

export const method = "instance.move";

export const description =
  "Reparent instances in batch: each item specifies a guid to move and the parentGuid of its new parent. " +
  "This changes hierarchy only — it does not translate objects in space.";

export const params = z
  .object({
    items: z
      .array(
        z.object({
          guid: z.string().describe("GUID of the instance to move"),
          parentGuid: z.string().describe("GUID of the new parent instance"),
        }),
      )
      .min(1)
      .max(10)
      .describe("Batch items to move."),
  })
  .strict();

export type InstanceMoveArgs = z.infer<typeof params>;

export function parseArgs(value: Record<string, unknown>): InstanceMoveArgs {
  return params.parse(value);
}
