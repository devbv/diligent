import { z } from "zod";

export const method = "script.grep";

export const description =
  "Search for a regex pattern across script sources in the level file. Returns matching lines with script name, GUID, and line numbers. Use parentGuid to limit search scope to a subtree.";

export const params = z.object({
  pattern: z.string().describe("Regex pattern to search for in script sources"),
  parentGuid: z
    .string()
    .optional()
    .describe(
      "GUID of a parent instance — only scripts under this subtree are searched. If omitted, searches all scripts.",
    ),
  ignore_case: z.boolean().optional().default(false).describe("Case-insensitive search"),
});
