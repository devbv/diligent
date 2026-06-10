import { z } from "zod";

export const method = "script.edit";

export const description = `Edit a script's source via string replacement.

IMPORTANT: Use tabs for indentation. Leading 4-space groups will be auto-converted to tabs.

Matching first tries exact text, then falls back to line-based matching that tolerates trailing whitespace,
leading/trailing whitespace, and common Unicode quote/dash/space variants.

The edit will FAIL if old_string is not unique in the script source.
Provide more surrounding context to make it unique, or set replace_all to true.
Use replace_all only when the same old_string should be replaced at every occurrence, such as renaming a variable
or replacing an identical repeated pattern across the script.

If an edit fails, call script_read to check the current source before retrying.

For multiple non-contiguous edits in one script, call studiorpc_script_edit once per edited region.
You may batch independent, non-overlapping edits as parallel tool calls.
If one edit changes text that another edit's old_string depends on, apply them sequentially or choose non-overlapping
old_string ranges so earlier edits do not invalidate later matches.

Do not use one edit call to describe unrelated non-contiguous changes. Rewrite a whole script only when most of the
file or its structure is being replaced; otherwise prefer targeted edits.`;

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
