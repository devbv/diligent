// @summary Shell command execution with timeout and output truncation

import { MAX_OUTPUT_BYTES } from "@diligent/core/tool/truncation";
import type { Tool, ToolResult } from "@diligent/core/tool/types";
import { existsSync } from "fs";
import { z } from "zod";
import { spawnProcess } from "../util/process";
import { type RuntimeToolHost, requestToolApproval } from "./capabilities";
import { createCommandRenderPayload } from "./render-payload";

const BashParams = z.object({
  command: z.string().min(1).describe("The shell command to execute"),
  description: z.string().optional().describe("Short description of what the command does (5-10 words)"),
  timeout: z.number().positive().optional().describe("Timeout in milliseconds. Default: 120000 (2 min)"),
});

const DEFAULT_TIMEOUT = 120_000;

const SENSITIVE_PATTERNS = [/(_API_KEY|_TOKEN|_PASSWORD)$/, /_SECRET/, /^(API_KEY|SECRET_KEY|TOKEN|PASSWORD)$/];

const CI_PASSLIST = new Set(["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN"]);

/**
 * Convert Windows-style backslash paths to forward slashes so bash doesn't
 * strip them as escape sequences. e.g. C:\Users\foo → C:/Users/foo
 */
function normalizePathSeparators(command: string): string {
  return command.replace(/([A-Za-z]):\\([\w\\. -]*)/g, (_, drive, rest) => `${drive}:/${rest.replace(/\\/g, "/")}`);
}

/** On Windows, prefer bash (Git Bash / WSL / MSYS2) over cmd.exe to avoid metacharacter issues. */
function resolveWindowsShell(command: string): string[] {
  const normalized = normalizePathSeparators(command);
  if (process.env.SHELL) return [process.env.SHELL, "-c", normalized];
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\msys64\\usr\\bin\\bash.exe",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return [candidate, "-c", normalized];
  }
  return [process.env.ComSpec || "cmd.exe", "/C", command];
}

export function filterSensitiveEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const filtered: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (CI_PASSLIST.has(key) || !SENSITIVE_PATTERNS.some((p) => p.test(key))) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export function createBashTool(cwd: string, host?: RuntimeToolHost): Tool<typeof BashParams> {
  return {
    name: "bash",
    description:
      "Execute a shell command. Use this to run programs, install packages, manage files, or interact with the system.",
    parameters: BashParams,
    async execute(args, ctx): Promise<ToolResult> {
      const approval = await requestToolApproval(host, {
        permission: "execute",
        toolName: "bash",
        description: args.description ?? args.command,
        details: { command: args.command },
      });
      if (approval === "reject") {
        ctx.abort();
        return {
          output: "[Rejected by user]",
          render: createCommandRenderPayload(args.command, "[Rejected by user]", true),
          metadata: { error: true },
        };
      }

      const timeout = args.timeout ?? DEFAULT_TIMEOUT;

      const isWindows = process.platform === "win32";
      const shellArgs = isWindows
        ? resolveWindowsShell(args.command)
        : [process.env.SHELL || "bash", "-c", args.command];

      let timedOut = false;
      let aborted = false;

      const ac = new AbortController();

      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, timeout);

      const onAbort = () => {
        aborted = true;
        ac.abort();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const proc = spawnProcess(shellArgs, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: filterSensitiveEnv(process.env) as NodeJS.ProcessEnv,
        signal: ac.signal,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      proc.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
      proc.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));

      let exitCode: number | null = null;
      try {
        exitCode = await proc.exited;
      } catch {
        // process killed — exitCode stays null
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      }

      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();

      let output = stdout;
      let truncated = false;
      if (stderr) output += `${output ? "\n" : ""}[stderr]\n${stderr}`;
      if (new TextEncoder().encode(output).length > MAX_OUTPUT_BYTES) {
        output = output.slice(-MAX_OUTPUT_BYTES);
        truncated = true;
      }

      let header = "";
      if (timedOut) header = `[Timed out after ${timeout / 1000}s]\n`;
      if (aborted) header = `[Aborted by user]\n`;
      if (exitCode !== 0 && exitCode !== null) header += `[Exit code: ${exitCode}]\n`;

      const finalOutput = header + output;
      return {
        output: finalOutput,
        render: createCommandRenderPayload(args.command, finalOutput, timedOut || aborted || exitCode !== 0),
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
}
