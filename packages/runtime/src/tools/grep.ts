// @summary Content search via ripgrep with regex support
import { resolve } from "node:path";
import type { Tool, ToolResult } from "@diligent/core/tool/types";
import { z } from "zod";
import { isAbsolute, stripExtendedLengthPrefix } from "../util/path";
import { spawnCollect } from "../util/process";
import { resolveRgBinary } from "../util/ripgrep";
import { createGrepRenderPayload, createTextRenderPayload } from "./render-payload";

const GrepParams = z.object({
  pattern: z.string().describe("Regex pattern to search for in file contents"),
  path: z
    .string()
    .optional()
    .describe("File or directory path to search in. Defaults to the current working directory"),
  include: z.string().optional().describe("Glob pattern to filter files (e.g., '*.ts')"),
  ignore_case: z.boolean().optional().describe("Case-insensitive search. Default: false"),
  context: z.number().int().min(0).optional().describe("Lines of context before and after each match"),
});

const MAX_MATCHES = 100;
const MAX_LINE_LENGTH = 2000;

export function createGrepTool(cwd: string): Tool<typeof GrepParams> {
  return {
    name: "grep",
    description:
      "Search file contents using regex. Returns matching lines with file paths and line numbers. " +
      "Use spawn_agent with agent_type='explore' for open-ended searches requiring multiple rounds.",
    parameters: GrepParams,
    supportParallel: true,
    async execute(args): Promise<ToolResult> {
      const rawPath = args.path ? (isAbsolute(args.path) ? args.path : resolve(cwd, args.path)) : cwd;
      const searchPath = stripExtendedLengthPrefix(rawPath)
        .replace(/\\/g, "/")
        .replace(/\/{2,}/g, "/");

      if (isFilesystemRoot(searchPath)) {
        const output = `Error: refusing to grep the filesystem root: ${searchPath}. Provide a narrower path.`;
        return { output, render: createTextRenderPayload(undefined, output, true), metadata: { error: true } };
      }

      const rgBin = resolveRgBinary();
      const rgArgs: string[] = [rgBin, "-n"];

      if (args.ignore_case) rgArgs.push("--ignore-case");
      if (args.include) rgArgs.push("--glob", args.include);
      if (args.context !== undefined) rgArgs.push("-C", String(args.context));

      rgArgs.push(args.pattern, searchPath);

      try {
        const [stdout, , exitCode] = await spawnCollect(rgArgs);

        if (exitCode !== 0 && !stdout.trim()) {
          const output = "No matches found.";
          return {
            output,
            render: createGrepRenderPayload({ ...args, path: searchPath }, "", { cwd }),
          };
        }

        // Parse and limit output
        const lines = stdout.trim().split("\n");
        const limited = lines.slice(0, MAX_MATCHES);
        const overflow = lines.length - MAX_MATCHES;

        // Truncate individual lines
        const truncated = limited.map((line) =>
          line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...` : line,
        );

        let output = truncated.join("\n");
        if (overflow > 0) {
          output += `\n\n... (${overflow} more matches not shown)`;
        }

        return {
          output,
          render: createGrepRenderPayload({ ...args, path: searchPath }, output, { cwd }),
          truncateDirection: "head",
        };
      } catch (err) {
        const output = `Error running grep: ${err instanceof Error ? err.message : String(err)}`;
        return {
          output,
          render: createTextRenderPayload(undefined, output, true),
          metadata: { error: true },
        };
      }
    },
  };
}

function isFilesystemRoot(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return normalized === "/" || /^[a-zA-Z]:\/$/.test(normalized);
}
