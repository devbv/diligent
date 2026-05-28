import { z } from "zod";

export const method = "script.edit";

export const description = `Edit a script's source via string replacement.

IMPORTANT: Use tabs for indentation. Leading 4-space groups will be auto-converted to tabs.

Matching first tries exact text, then falls back to line-based matching that tolerates trailing whitespace,
leading/trailing whitespace, and common Unicode quote/dash/space variants.

The edit will FAIL if old_string is not unique in the script source.
Provide more surrounding context to make it unique, or set replace_all to true.
Use replace_all for renaming variables or replacing repeated patterns across the script.

If an edit fails, call script_read to check the current source before retrying.

When a single file needs multiple independent edits, issue all of them as parallel tool calls in one batch instead of one-at-a-time round trips.`;

export const params = z.object({
  targetGuid: z.string().describe("GUID of the script to edit"),
  old_string: z.string().describe("The exact text to find in the script source"),
  new_string: z.string().describe("The replacement text"),
  replace_all: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, replace every occurrence of old_string instead of requiring uniqueness"),
});
