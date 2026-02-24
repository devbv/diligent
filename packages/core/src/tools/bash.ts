import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../tool/types";

const BashParams = z.object({
  command: z.string().min(1).describe("The shell command to execute"),
  description: z.string().optional().describe("Short description of what the command does (5-10 words)"),
  timeout: z.number().positive().optional().describe("Timeout in milliseconds. Default: 120000 (2 min)"),
});

const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB

export const bashTool: Tool<typeof BashParams> = {
  name: "bash",
  description:
    "Execute a shell command. Use this to run programs, install packages, manage files, or interact with the system.",
  parameters: BashParams,
  async execute(args, ctx): Promise<ToolResult> {
    const timeout = args.timeout ?? DEFAULT_TIMEOUT;

    const proc = Bun.spawn(["bash", "-c", args.command], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeout);

    const onAbort = () => {
      aborted = true;
      proc.kill("SIGKILL");
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const [stdoutText, stderrText] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      stdout = stdoutText;
      stderr = stderrText;

      await proc.exited;
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }

    const exitCode = proc.exitCode;

    let output = stdout;
    let truncated = false;
    if (stderr) output += (output ? "\n" : "") + `[stderr]\n${stderr}`;
    if (new TextEncoder().encode(output).length > MAX_OUTPUT_BYTES) {
      output = output.slice(-MAX_OUTPUT_BYTES);
      truncated = true;
    }

    let header = "";
    if (timedOut) header = `[Timed out after ${timeout / 1000}s]\n`;
    if (aborted) header = `[Aborted by user]\n`;
    if (exitCode !== 0 && exitCode !== null) header += `[Exit code: ${exitCode}]\n`;

    return {
      output: header + output,
      metadata: {
        exitCode,
        timedOut,
        aborted,
        truncated,
        ...(args.description && { description: args.description }),
      },
    };
  },
};
