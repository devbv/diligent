import { z } from "zod";
import { stat } from "node:fs/promises";
import type { Tool, ToolResult } from "../tool/types";

const GlobParams = z.object({
  pattern: z.string().describe("Glob pattern to match files (e.g., '**/*.ts', 'src/**/*.test.ts')"),
  path: z.string().optional().describe("Directory to search in. Default: current working directory"),
});

const MAX_FILES = 100;

export function createGlobTool(cwd: string): Tool<typeof GlobParams> {
  return {
    name: "glob",
    description:
      "Find files matching a glob pattern. Returns file paths sorted by modification time (newest first).",
    parameters: GlobParams,
    async execute(args): Promise<ToolResult> {
      const searchPath = args.path ?? cwd;

      try {
        const proc = Bun.spawn(
          ["rg", "--files", "--glob", args.pattern, searchPath],
          { stdout: "pipe", stderr: "pipe" },
        );

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        await proc.exited;

        if (proc.exitCode !== 0 && !stdout.trim()) {
          // rg returns exit code 1 for no matches
          if (proc.exitCode === 1) {
            return { output: "No files found matching pattern." };
          }
          return {
            output: `Error running glob: ${stderr.trim()}`,
            metadata: { error: true },
          };
        }

        const files = stdout.trim().split("\n").filter(Boolean);

        // Stat each file for mtime, sort descending (newest first)
        const withMtime = await Promise.all(
          files.map(async (f) => {
            try {
              const s = await stat(f);
              return { path: f, mtime: s.mtimeMs };
            } catch {
              return { path: f, mtime: 0 };
            }
          }),
        );

        withMtime.sort((a, b) => b.mtime - a.mtime);

        const limited = withMtime.slice(0, MAX_FILES);
        let output = limited.map((f) => f.path).join("\n");

        if (withMtime.length > MAX_FILES) {
          output += `\n\n... (${withMtime.length - MAX_FILES} more files not shown)`;
        }

        return { output };
      } catch (err) {
        return {
          output: `Error running glob: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { error: true },
        };
      }
    },
  };
}
