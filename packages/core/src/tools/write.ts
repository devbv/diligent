import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "../tool/types";

const WriteParams = z.object({
  file_path: z.string().describe("The absolute path to the file to write"),
  content: z.string().describe("The full content to write to the file"),
});

export function createWriteTool(): Tool<typeof WriteParams> {
  return {
    name: "write",
    description:
      "Write content to a file. Creates the file and parent directories if they don't exist. Overwrites existing content.",
    parameters: WriteParams,
    async execute(args, ctx): Promise<ToolResult> {
      const { file_path, content } = args;

      const approval = await ctx.approve({
        permission: "write",
        toolName: "write",
        description: `Write to ${file_path}`,
        details: { file_path },
      });
      if (approval === "reject") {
        return { output: "[Rejected by user]", metadata: { error: true } };
      }

      try {
        // 1. Create parent directories recursively
        await mkdir(dirname(file_path), { recursive: true });

        // 2. Write content to file
        await Bun.write(file_path, content);

        // 3. Return summary
        const bytes = new TextEncoder().encode(content).length;
        return { output: `Wrote ${bytes} bytes to ${file_path}` };
      } catch (err) {
        return {
          output: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { error: true },
        };
      }
    },
  };
}
