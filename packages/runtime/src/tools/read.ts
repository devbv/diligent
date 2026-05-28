// @summary Read file with binary detection and line numbers

import type { Tool, ToolResult } from "@diligent/core/tool/types";
import { z } from "zod";
import { isAbsolute, stripExtendedLengthPrefix } from "../util/path";
import { createTextRenderPayload, summarizeRenderText } from "./render-payload";

const ReadParams = z.object({
  file_path: z.string().describe("The absolute path to the file to read"),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Line number to start reading from (1-indexed). Only provide for large files"),
  limit: z.number().int().positive().optional().describe("Maximum number of lines to read. Default: 2000"),
});

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".wasm",
  ".zip",
  ".gz",
  ".tar",
  ".bz2",
  ".7z",
  ".rar",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".a",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".wav",
  ".flac",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".class",
  ".pyc",
  ".pyo",
]);

const DEFAULT_LIMIT = 2000;

function isBinaryByExtension(filePath: string): boolean {
  const dotIdx = filePath.lastIndexOf(".");
  if (dotIdx === -1) return false;
  const ext = filePath.slice(dotIdx).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function isBinaryByContent(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let nullCount = 0;
  for (const byte of bytes) {
    if (byte === 0) nullCount++;
  }
  return nullCount / bytes.length > 0.3;
}

function formatLineNumber(lineNum: number, maxLineNum: number): string {
  const width = String(maxLineNum).length;
  return `${String(lineNum).padStart(width)}\t`;
}

function buildReadSummary(lineCount: number): string {
  return `${lineCount} line${lineCount === 1 ? "" : "s"} read`;
}

export function createReadTool(): Tool<typeof ReadParams> {
  return {
    name: "read",
    description: "Read a file from the filesystem. Returns file contents with line numbers.",
    parameters: ReadParams,
    supportParallel: true,
    async execute(args): Promise<ToolResult> {
      const file_path = stripExtendedLengthPrefix(args.file_path);
      const { offset, limit } = args;
      if (!isAbsolute(file_path)) {
        const output = `Error: file_path must be absolute: ${file_path}`;
        return { output, render: createTextRenderPayload(undefined, output, true), metadata: { error: true } };
      }

      // 1. Check file exists
      const file = Bun.file(file_path);
      if (!(await file.exists())) {
        const output = `Error: File not found: ${file_path}`;
        return { output, render: createTextRenderPayload(undefined, output, true), metadata: { error: true } };
      }

      // 2. Binary detection by extension
      if (isBinaryByExtension(file_path)) {
        const size = file.size;
        const output = `Binary file (${size} bytes). Cannot display contents. For image files (.png/.jpg/.gif/.webp), use the read_image tool instead.`;
        return {
          output,
          render: {
            inputSummary: summarizeRenderText(file_path),
            outputSummary: summarizeRenderText(output),
            blocks: [{ type: "text", title: file_path, text: output }],
          },
        };
      }

      // 3. Binary detection by content sampling
      try {
        const sample = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
        if (isBinaryByContent(sample)) {
          const size = file.size;
          const output = `Binary file (${size} bytes). Cannot display contents. For image files (.png/.jpg/.gif/.webp), use the read_image tool instead.`;
          return {
            output,
            render: {
              inputSummary: summarizeRenderText(file_path),
              outputSummary: summarizeRenderText(output),
              blocks: [{ type: "text", title: file_path, text: output }],
            },
          };
        }
      } catch {
        // If content check fails, continue as text
      }

      // 4. Read file content
      let content: string;
      try {
        content = await file.text();
      } catch (err) {
        const output = `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
        return {
          output,
          render: createTextRenderPayload(undefined, output, true),
          metadata: { error: true },
        };
      }

      // 5. Apply offset/limit
      const allLines = content.split("\n");
      const startLine = offset ? offset - 1 : 0; // convert 1-indexed to 0-indexed
      const maxLines = limit ?? DEFAULT_LIMIT;
      const selectedLines = allLines.slice(startLine, startLine + maxLines);
      const totalLines = allLines.length;

      // 6. Prepend line numbers (cat -n format)
      const maxLineNum = startLine + selectedLines.length;
      const numbered = selectedLines.map((line, i) => formatLineNumber(startLine + i + 1, maxLineNum) + line);

      let output = numbered.join("\n");

      // Add truncation note if applicable
      if (startLine + maxLines < totalLines) {
        output += `\n\n... (showing lines ${startLine + 1}-${startLine + selectedLines.length} of ${totalLines} total)`;
      }

      return {
        output,
        render: {
          inputSummary: summarizeRenderText(file_path),
          outputSummary: buildReadSummary(selectedLines.length),
          blocks: [
            {
              type: "file",
              filePath: file_path,
              content,
              offset,
              limit: maxLines,
            },
          ],
        },
        truncateDirection: "head",
      };
    },
  };
}
