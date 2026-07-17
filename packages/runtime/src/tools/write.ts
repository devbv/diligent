// @summary Write file contents with directory auto-creation
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Tool, ToolResult } from "@diligent/core/tool-contract";
import { z } from "zod";
import { isAbsolute, stripExtendedLengthPrefix } from "../util/path";
import { type RuntimeToolHost, requestToolApproval } from "./capabilities";
import { createFileRenderPayload, createTextRenderPayload } from "./render-payload";

const WriteParams = z.object({
  file_path: z.string().describe("The relative path to the file to write"),
  content: z.string().describe("The full content to write to the file"),
});

export function createWriteTool(cwd: string, host?: RuntimeToolHost): Tool<typeof WriteParams> {
  return {
    name: "write",
    description:
      "Write content to a file. Creates the file and parent directories if they don't exist. Overwrites existing content.",
    parameters: WriteParams,
    async execute(args, ctx): Promise<ToolResult> {
      const { file_path, content } = args;
      if (isAbsolute(file_path)) {
        const output = `Error: file_path must be relative: ${file_path}`;
        return { output, render: createTextRenderPayload(undefined, output, true), metadata: { error: true } };
      }
      const targetPath = resolve(cwd, file_path);

      const approval = await requestToolApproval(host, {
        permission: "write",
        toolName: "write",
        description: `Write to ${targetPath}`,
        details: { file_path: targetPath },
      });
      if (approval === "reject") {
        ctx.abort();
        return {
          output: "[Rejected by user]",
          render: createTextRenderPayload(undefined, "[Rejected by user]", true),
          metadata: { error: true },
        };
      }

      try {
        // 1. Create parent directories recursively
        await mkdir(dirname(targetPath), { recursive: true });

        // 2. Write content to file
        await Bun.write(targetPath, content);

        // 3. Return summary
        const bytes = new TextEncoder().encode(content).length;
        const output = `Wrote ${bytes} bytes to ${targetPath}`;
        return {
          output,
          render: createFileRenderPayload({
            filePath: targetPath,
            content,
            outputText: output,
            actionSummary: "1 file written",
          }),
        };
      } catch (err) {
        const output = `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
        return {
          output,
          render: createTextRenderPayload(undefined, output, true),
          metadata: { error: true },
        };
      }
    },
  };
}

const WriteAbsoluteParams = z.object({
  file_path: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
  content: z.string().describe("The content to write to the file"),
});

/**
 * Write tool variant for non-OpenAI models — accepts absolute paths.
 */
export function createWriteAbsoluteTool(host?: RuntimeToolHost): Tool<typeof WriteAbsoluteParams> {
  return {
    name: "write",
    description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.`,
    parameters: WriteAbsoluteParams,
    async execute(args, ctx): Promise<ToolResult> {
      const file_path = stripExtendedLengthPrefix(args.file_path);
      const { content } = args;
      if (!isAbsolute(file_path)) {
        const output = `Error: file_path must be absolute: ${file_path}`;
        return { output, render: createTextRenderPayload(undefined, output, true), metadata: { error: true } };
      }

      const approval = await requestToolApproval(host, {
        permission: "write",
        toolName: "write",
        description: `Write to ${file_path}`,
        details: { file_path },
      });
      if (approval === "reject") {
        ctx.abort();
        return {
          output: "[Rejected by user]",
          render: createTextRenderPayload(undefined, "[Rejected by user]", true),
          metadata: { error: true },
        };
      }

      try {
        await mkdir(dirname(file_path), { recursive: true });
        await Bun.write(file_path, content);
        const bytes = new TextEncoder().encode(content).length;
        const output = `Wrote ${bytes} bytes to ${file_path}`;
        return {
          output,
          render: createFileRenderPayload({
            filePath: file_path,
            content,
            outputText: output,
            actionSummary: "1 file written",
          }),
        };
      } catch (err) {
        const output = `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
        return {
          output,
          render: createTextRenderPayload(undefined, output, true),
          metadata: { error: true },
        };
      }
    },
  };
}
