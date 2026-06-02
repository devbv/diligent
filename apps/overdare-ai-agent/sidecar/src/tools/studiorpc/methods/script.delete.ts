import { z } from "zod";

export const method = "script.delete";

export const description = "Delete a script instance.";

export const params = z.object({
  targetGuid: z.string().describe("GUID of the script to delete"),
});
