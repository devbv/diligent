import { z } from "zod";

export const method = "instance.delete";

export const description =
  "Delete instances in batch by GUID. Each item specifies a targetGuid to remove from the level.";

export const params = z
  .object({
    items: z
      .array(z.object({ targetGuid: z.string().describe("GUID of the instance to delete") }))
      .min(1)
      .describe("Batch items to delete."),
  })
  .strict();

export type InstanceDeleteArgs = z.infer<typeof params>;

export function parseArgs(value: Record<string, unknown>): InstanceDeleteArgs {
  return params.parse(value);
}
