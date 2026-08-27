import { z } from "zod";

export const method = "script.delete";

export const description = "Delete a script instance.";

export const params = z.object({
  guid: z
    .string()
    .describe(
      "GUID of the script to delete — the GUID studiorpc_level_browse, studiorpc_script_grep and studiorpc_instance_read all report.",
    ),
});
