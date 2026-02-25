import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool, ToolResult } from "../tool/types";

const EditParams = z.object({
  file_path: z.string().describe("The absolute path to the file to edit"),
  old_string: z.string().describe("The exact string to find and replace. Must match exactly."),
  new_string: z.string().describe("The replacement string"),
});

export function createEditTool(): Tool<typeof EditParams> {
  return {
    name: "edit",
    description: "Replace an exact string in a file. The old_string must appear exactly once in the file.",
    parameters: EditParams,
    async execute(args): Promise<ToolResult> {
      const { file_path, old_string, new_string } = args;

      // 1. Read file content
      let content: string;
      try {
        content = await readFile(file_path, "utf-8");
      } catch (err) {
        return {
          output: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { error: true },
        };
      }

      // 2. Count occurrences
      const occurrences = countOccurrences(content, old_string);

      // 3. Single-occurrence guard
      if (occurrences === 0) {
        return {
          output: `Error: old_string not found in file`,
          metadata: { error: true },
        };
      }
      if (occurrences > 1) {
        return {
          output: `Error: old_string found ${occurrences} times — provide more context to make it unique`,
          metadata: { error: true },
        };
      }

      // 4. Replace the single occurrence
      const newContent = content.replace(old_string, new_string);

      // 5. Write file
      await writeFile(file_path, newContent, "utf-8");

      // 6. Generate unified diff
      const diff = generateUnifiedDiff(file_path, content, newContent);

      // 7. Return diff as output
      return { output: diff };
    },
  };
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = text.indexOf(search, pos);
    if (idx === -1) break;
    count++;
    pos = idx + 1;
  }
  return count;
}

function generateUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // Find the first different line
  let firstDiff = 0;
  while (firstDiff < oldLines.length && firstDiff < newLines.length && oldLines[firstDiff] === newLines[firstDiff]) {
    firstDiff++;
  }

  // Find the last different line (from the end)
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd > firstDiff && newEnd > firstDiff && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  // Context lines
  const contextLines = 4;
  const startLine = Math.max(0, firstDiff - contextLines);
  const oldEndWithCtx = Math.min(oldLines.length - 1, oldEnd + contextLines);
  const newEndWithCtx = Math.min(newLines.length - 1, newEnd + contextLines);

  const lines: string[] = [];
  lines.push(`--- ${filePath}`);
  lines.push(`+++ ${filePath}`);
  lines.push(
    `@@ -${startLine + 1},${oldEndWithCtx - startLine + 1} +${startLine + 1},${newEndWithCtx - startLine + 1} @@`,
  );

  // Context before
  for (let i = startLine; i < firstDiff; i++) {
    lines.push(` ${oldLines[i]}`);
  }

  // Removed lines
  for (let i = firstDiff; i <= oldEnd; i++) {
    lines.push(`-${oldLines[i]}`);
  }

  // Added lines
  for (let i = firstDiff; i <= newEnd; i++) {
    lines.push(`+${newLines[i]}`);
  }

  // Context after
  for (let i = Math.max(oldEnd, newEnd) + 1; i <= Math.min(oldEndWithCtx, newEndWithCtx); i++) {
    if (i < oldLines.length) {
      lines.push(` ${oldLines[i]}`);
    }
  }

  return lines.join("\n");
}
