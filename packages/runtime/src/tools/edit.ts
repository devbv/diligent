// @summary Edit file contents via exact string replacement
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolResult } from "@diligent/core/tool-contract";
import { z } from "zod";
import { isAbsolute, stripExtendedLengthPrefix } from "../util/path";
import { type RuntimeToolHost, requestToolApproval } from "./capabilities";
import {
  createEditDiffRenderPayload,
  createMultiEditDiffRenderPayload,
  createTextRenderPayload,
} from "./render-payload";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const EditParams = z.object({
  file_path: z.string().describe("The absolute path to the file to edit"),
  old_string: z.string().describe("The exact text to find and replace"),
  new_string: z.string().describe("The replacement text"),
  replace_all: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, replace every occurrence of old_string instead of requiring uniqueness"),
});

const MultiEditParams = z.object({
  file_path: z.string().describe("The absolute path to the file to edit"),
  edits: z
    .array(
      z.object({
        old_string: z.string().describe("The exact text to find and replace"),
        new_string: z.string().describe("The replacement text"),
        replace_all: z.boolean().optional().default(false),
      }),
    )
    .min(1)
    .describe("Ordered list of edits to apply sequentially"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SingleEdit {
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

/**
 * Validate and apply a single edit to `content`, returning the new content and
 * the number of replacements made. Throws on validation failure.
 */
function applyEdit(content: string, edit: SingleEdit): { result: string; count: number } {
  const { old_string, new_string, replace_all } = edit;

  if (old_string === new_string) {
    throw new Error("old_string and new_string must differ");
  }

  const occurrences = countOccurrences(content, old_string);

  if (replace_all) {
    if (occurrences === 0) {
      throw new Error("old_string not found in file");
    }
    return { result: content.replaceAll(old_string, new_string), count: occurrences };
  }

  // Unique match mode
  if (occurrences === 0) {
    throw new Error("old_string not found in file");
  }
  if (occurrences > 1) {
    throw new Error("old_string is not unique, provide more context or use replace_all");
  }

  return { result: content.replace(old_string, new_string), count: 1 };
}

// ---------------------------------------------------------------------------
// edit tool
// ---------------------------------------------------------------------------

export function createEditTool(host?: RuntimeToolHost): Tool<typeof EditParams> {
  return {
    name: "edit",
    description: `Performs exact string replacements in files.

Usage:
- You must use your Read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`,
    parameters: EditParams,

    async execute(args, ctx): Promise<ToolResult> {
      const file_path = stripExtendedLengthPrefix(args.file_path);
      const { old_string, new_string, replace_all } = args;

      if (!isAbsolute(file_path)) {
        return { output: `Error: file_path must be absolute: ${file_path}`, metadata: { error: true } };
      }

      // --- Create-new-file mode ---
      if (old_string === "") {
        const exists = await fileExists(file_path);
        if (exists) {
          return {
            output:
              "Error: old_string is empty but file already exists. Use a non-empty old_string to edit an existing file.",
            metadata: { error: true },
          };
        }

        const approval = await requestToolApproval(host, {
          permission: "write",
          toolName: "edit",
          description: `Create ${file_path}`,
          details: { file_path },
        });
        if (approval === "reject") {
          ctx.abort();
          return { output: "[Rejected by user]", metadata: { error: true } };
        }

        try {
          await mkdir(dirname(file_path), { recursive: true });
          await Bun.write(file_path, new_string);
          const output = `Created ${file_path}`;
          return {
            output,
            render: createEditDiffRenderPayload({
              filePath: file_path,
              oldString: old_string,
              newString: new_string,
              outputText: output,
              actionSummary: "1 file created",
            }),
          };
        } catch (err) {
          return {
            output: `Error creating file: ${err instanceof Error ? err.message : String(err)}`,
            metadata: { error: true },
          };
        }
      }

      // --- Edit existing file ---
      let content: string;
      try {
        content = await Bun.file(file_path).text();
      } catch (err) {
        return {
          output: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { error: true },
        };
      }

      let result: string;
      let count: number;
      try {
        ({ result, count } = applyEdit(content, { old_string, new_string, replace_all }));
      } catch (err) {
        return {
          output: `Error: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { error: true },
        };
      }

      const approval = await requestToolApproval(host, {
        permission: "write",
        toolName: "edit",
        description: `Edit ${file_path}`,
        details: { file_path },
      });
      if (approval === "reject") {
        ctx.abort();
        return { output: "[Rejected by user]", metadata: { error: true } };
      }

      try {
        await Bun.write(file_path, result);
        const output = `Edited ${file_path}: replaced ${count} occurrence(s)`;
        return {
          output,
          render: createEditDiffRenderPayload({
            filePath: file_path,
            oldString: old_string,
            newString: new_string,
            outputText: output,
            actionSummary: `${count} edit${count === 1 ? "" : "s"} applied`,
          }),
        };
      } catch (err) {
        return {
          output: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { error: true },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// multi_edit tool
// ---------------------------------------------------------------------------

export function createMultiEditTool(host?: RuntimeToolHost): Tool<typeof MultiEditParams> {
  return {
    name: "multi_edit",
    description: `This is a tool for making multiple edits to a single file in one operation. It is built on top of the Edit tool and allows you to perform multiple find-and-replace operations efficiently. Prefer this tool over the Edit tool when you need to make multiple edits to the same file.

Before using this tool:
- Use the Read tool to understand the file's contents and context
- Verify the directory path is correct

IMPORTANT:
- All edits are applied in sequence, in the order they are provided
- Each edit operates on the result of the previous edit
- All edits must be valid for the operation to succeed - if any edit fails, none will be applied
- The edits are atomic - either all succeed or none are applied
- Plan your edits carefully to avoid conflicts between sequential operations

WARNING:
- The tool will fail if edits.old_string doesn't match the file contents exactly (including whitespace)
- The tool will fail if edits.old_string and edits.new_string are the same
- Since edits are applied in sequence, ensure that earlier edits don't affect the text that later edits are trying to find

When making edits:
- Ensure all edits result in idiomatic, correct code
- Do not leave the code in a broken state
- Always use absolute file paths (starting with /)
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
`,
    parameters: MultiEditParams,

    async execute(args, ctx): Promise<ToolResult> {
      const file_path = stripExtendedLengthPrefix(args.file_path);
      const { edits } = args;

      if (!isAbsolute(file_path)) {
        return { output: `Error: file_path must be absolute: ${file_path}`, metadata: { error: true } };
      }

      let content: string;
      try {
        content = await Bun.file(file_path).text();
      } catch (err) {
        return {
          output: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { error: true },
        };
      }

      // Validate and apply all edits on an in-memory copy (atomic: fail before writing)
      let current = content;
      let totalCount = 0;
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        try {
          const { result, count } = applyEdit(current, {
            old_string: edit.old_string,
            new_string: edit.new_string,
            replace_all: edit.replace_all,
          });
          current = result;
          totalCount += count;
        } catch (err) {
          const output = `Error in edit ${i + 1}/${edits.length}: ${err instanceof Error ? err.message : String(err)}`;
          return { output, render: createTextRenderPayload(undefined, output, true), metadata: { error: true } };
        }
      }

      const approval = await requestToolApproval(host, {
        permission: "write",
        toolName: "multi_edit",
        description: `Multi-edit ${file_path} (${edits.length} edits)`,
        details: { file_path, editCount: edits.length },
      });
      if (approval === "reject") {
        ctx.abort();
        return { output: "[Rejected by user]", metadata: { error: true } };
      }

      try {
        await Bun.write(file_path, current);
        const output = `Edited ${file_path}: applied ${edits.length} edit(s), replaced ${totalCount} occurrence(s) total`;
        return {
          output,
          render: createMultiEditDiffRenderPayload({
            filePath: file_path,
            edits,
            outputText: output,
            actionSummary: `${edits.length} edit${edits.length === 1 ? "" : "s"} applied`,
          }),
        };
      } catch (err) {
        return {
          output: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { error: true },
        };
      }
    },
  };
}
