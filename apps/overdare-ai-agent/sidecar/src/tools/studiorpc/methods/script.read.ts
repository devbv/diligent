import { z } from "zod";

export const method = "script.read";

export const description =
  'Read a script\'s source code from the level file by GUID. Returns source with line numbers in "{LineNumber}\\t{Content}" format (e.g. "1\\tlocal x = 1\\n2\\tprint(x)"). Note: the first tab on each line is the line-number delimiter, not indentation. Actual indentation appears after it.';

export const params = z.object({
  guid: z
    .string()
    .describe(
      "GUID of the script to read — the GUID studiorpc_level_browse, studiorpc_script_grep and studiorpc_instance_read all report.",
    ),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Line number to start reading from (1-indexed). Only provide for large scripts"),
  limit: z.number().int().positive().optional().describe("Maximum number of lines to read. Default: 2000"),
});
