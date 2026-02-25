import { z } from "zod";
import type { Tool, ToolResult } from "../tool/types";

const GrepParams = z.object({
  pattern: z.string().describe("Regex pattern to search for in file contents"),
  path: z.string().optional().describe("File or directory to search in. Default: current working directory"),
  include: z.string().optional().describe("Glob pattern to filter files (e.g., '*.ts')"),
  ignore_case: z.boolean().optional().describe("Case-insensitive search. Default: false"),
  context: z.number().int().min(0).optional().describe("Lines of context before and after each match"),
});

const MAX_MATCHES = 100;
const MAX_LINE_LENGTH = 2000;

export function createGrepTool(cwd: string): Tool<typeof GrepParams> {
  return {
    name: "grep",
    description: "Search file contents using regex. Returns matching lines with file paths and line numbers.",
    parameters: GrepParams,
    async execute(args): Promise<ToolResult> {
      const searchPath = args.path ?? cwd;

      const rgArgs: string[] = ["rg", "-n"];

      if (args.ignore_case) rgArgs.push("--ignore-case");
      if (args.include) rgArgs.push("--glob", args.include);
      if (args.context !== undefined) rgArgs.push("-C", String(args.context));

      rgArgs.push(args.pattern, searchPath);

      try {
        const proc = Bun.spawn(rgArgs, { stdout: "pipe", stderr: "pipe" });

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        await proc.exited;

        if (proc.exitCode !== 0 && !stdout.trim()) {
          if (proc.exitCode === 1) {
            return { output: "No matches found." };
          }
          return {
            output: `Error running grep: ${stderr.trim()}`,
            metadata: { error: true },
          };
        }

        // Parse and limit output
        const lines = stdout.trim().split("\n");
        const limited = lines.slice(0, MAX_MATCHES);

        // Truncate individual lines
        const truncated = limited.map((line) =>
          line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...` : line,
        );

        let output = truncated.join("\n");

        if (lines.length > MAX_MATCHES) {
          output += `\n\n... (${lines.length - MAX_MATCHES} more matches not shown)`;
        }

        return { output, truncateDirection: "head" };
      } catch (err) {
        return {
          output: `Error running grep: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { error: true },
        };
      }
    },
  };
}
