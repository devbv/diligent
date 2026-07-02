// @summary Regression tests: Windows backslash paths are normalized before being passed to ripgrep

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { createGlobTool } from "../../src/tools/glob";
import { createGrepTool } from "../../src/tools/grep";
import { dirnameCrossPlatform, relativeCrossPlatform, resolveCrossPlatformPath } from "../../src/util/path";

const UNIX_CWD = "/home/user/project";
const WIN_CWD_BACKSLASH = "C:\\Users\\alice\\git\\diligent";
const WIN_CWD_FORWARD = "C:/Users/alice/git/diligent";

const mockCtx = {
  toolCallId: "test-call-id",
  signal: new AbortController().signal,
  abort: () => {},
};

function mockProc(stdoutText = "", exitCode = 0) {
  const stdout = new EventEmitter() as NodeJS.ReadableStream;
  const stderr = new EventEmitter() as NodeJS.ReadableStream;
  const proc = new EventEmitter() as ReturnType<typeof childProcess.spawn>;
  (proc as unknown as { stdout: unknown; stderr: unknown; exitCode: number; signalCode: null; pid: number }).stdout =
    stdout;
  (proc as unknown as { stdout: unknown; stderr: unknown; exitCode: number; signalCode: null; pid: number }).stderr =
    stderr;
  (proc as unknown as { stdout: unknown; stderr: unknown; exitCode: number; signalCode: null; pid: number }).exitCode =
    exitCode;
  (
    proc as unknown as { stdout: unknown; stderr: unknown; exitCode: number; signalCode: null; pid: number }
  ).signalCode = null;
  (proc as unknown as { stdout: unknown; stderr: unknown; exitCode: number; signalCode: null; pid: number }).pid =
    99999;
  (proc as unknown as { kill: () => void }).kill = () => {};
  setImmediate(() => {
    stdout.emit("data", Buffer.from(stdoutText));
    proc.emit("exit", exitCode, null);
  });
  return proc;
}

// With child_process.spawn(cmd, args, opts): calls[0][0]=cmd, calls[0][1]=args[]
// The search path is the last element of args
function capturedSearchPath(spy: ReturnType<typeof spyOn>): string {
  const args = spy.mock.calls[0][1] as string[];
  return args[args.length - 1];
}

describe("glob - Windows path normalization", () => {
  let spy: ReturnType<typeof spyOn>;

  afterEach(() => spy?.mockRestore());

  it("normalizes backslash path to forward slashes", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc("file.ts\n"));
    const tool = createGlobTool(UNIX_CWD);

    await tool.execute({ pattern: "**/*.ts", path: WIN_CWD_BACKSLASH }, mockCtx);

    expect(capturedSearchPath(spy)).toBe(WIN_CWD_FORWARD);
  });

  it("normalizes backslash cwd when no path arg", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc("file.ts\n"));
    const tool = createGlobTool(WIN_CWD_BACKSLASH);

    await tool.execute({ pattern: "**/*.ts" }, mockCtx);

    expect(capturedSearchPath(spy)).toBe(WIN_CWD_FORWARD);
  });

  it("normalizes nested backslash paths", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc(""));
    const tool = createGlobTool(UNIX_CWD);

    await tool.execute({ pattern: "*.ts", path: "C:\\Users\\alice\\git\\diligent\\packages\\core\\src" }, mockCtx);

    expect(capturedSearchPath(spy)).toBe("C:/Users/alice/git/diligent/packages/core/src");
  });

  it("leaves forward-slash paths unchanged", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc(""));
    const tool = createGlobTool(UNIX_CWD);

    await tool.execute({ pattern: "**/*.ts", path: WIN_CWD_FORWARD }, mockCtx);

    expect(capturedSearchPath(spy)).toBe(WIN_CWD_FORWARD);
  });

  it("leaves Unix paths unchanged", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc(""));
    const tool = createGlobTool(UNIX_CWD);

    await tool.execute({ pattern: "**/*.ts", path: "/home/user/project/src" }, mockCtx);

    expect(capturedSearchPath(spy)).toBe("/home/user/project/src");
  });

  it("normalizes double backslash path (literal \\\\) to single forward slashes", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc(""));
    const tool = createGlobTool(UNIX_CWD);

    // Double backslash: C:\\Users\\alice (two backslash chars between segments)
    await tool.execute({ pattern: "*.ts", path: "C:\\\\Users\\\\alice\\\\git" }, mockCtx);

    expect(capturedSearchPath(spy)).toBe("C:/Users/alice/git");
  });

  it("strips \\\\?\\ extended-length prefix from path", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc("file.ts\n"));
    const tool = createGlobTool(UNIX_CWD);

    await tool.execute({ pattern: "**/*.ts", path: "\\\\?\\C:\\Users\\alice\\git\\diligent" }, mockCtx);

    expect(capturedSearchPath(spy)).toBe(WIN_CWD_FORWARD);
  });

  it("strips \\\\?\\ extended-length prefix from cwd", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc("file.ts\n"));
    const tool = createGlobTool("\\\\?\\C:\\Users\\alice\\git\\diligent");

    await tool.execute({ pattern: "**/*.ts" }, mockCtx);

    expect(capturedSearchPath(spy)).toBe(WIN_CWD_FORWARD);
  });

  it("rejects relative paths with error", async () => {
    const tool = createGlobTool(UNIX_CWD);

    const result = await tool.execute({ pattern: "**/*.ts", path: "relative/path" }, mockCtx);

    expect(result.metadata).toMatchObject({
      error: true,
      status: {
        kind: "invalid_scope",
        code: "relative_path",
        path: "relative/path",
        retryable: false,
        actionable: true,
      },
    });
    expect(result.output).toContain("must be absolute");
  });

  it("rejects Windows filesystem root path with structured status", async () => {
    const tool = createGlobTool(UNIX_CWD);

    const result = await tool.execute({ pattern: "**/*.ts", path: "C:/" }, mockCtx);

    expect(result.output).toContain("refusing to glob the filesystem root");
    expect(result.metadata).toMatchObject({
      error: true,
      status: {
        kind: "invalid_scope",
        code: "filesystem_root",
        path: "C:/",
        retryable: false,
        actionable: true,
      },
    });
  });
});

describe("grep - Windows path normalization", () => {
  let spy: ReturnType<typeof spyOn>;

  afterEach(() => spy?.mockRestore());

  it("normalizes backslash path to forward slashes", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc("file.ts:1:match\n"));
    const tool = createGrepTool(UNIX_CWD);

    await tool.execute({ pattern: "foo", path: WIN_CWD_BACKSLASH }, mockCtx);

    expect(capturedSearchPath(spy)).toBe(WIN_CWD_FORWARD);
  });

  it("normalizes backslash cwd when no path arg", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc(""));
    const tool = createGrepTool(WIN_CWD_BACKSLASH);

    await tool.execute({ pattern: "foo" }, mockCtx);

    expect(capturedSearchPath(spy)).toBe(WIN_CWD_FORWARD);
  });

  it("normalizes resolved path when relative path given against backslash cwd", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc(""));
    const tool = createGrepTool(WIN_CWD_BACKSLASH);

    await tool.execute({ pattern: "foo", path: "packages/core" }, mockCtx);

    expect(capturedSearchPath(spy)).not.toContain("\\");
  });

  it("normalizes nested backslash paths", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc(""));
    const tool = createGrepTool(UNIX_CWD);

    await tool.execute({ pattern: "foo", path: "C:\\Users\\alice\\git\\diligent\\packages\\core\\src" }, mockCtx);

    expect(capturedSearchPath(spy)).toBe("C:/Users/alice/git/diligent/packages/core/src");
  });

  it("leaves forward-slash paths unchanged", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc(""));
    const tool = createGrepTool(UNIX_CWD);

    await tool.execute({ pattern: "foo", path: WIN_CWD_FORWARD }, mockCtx);

    expect(capturedSearchPath(spy)).toBe(WIN_CWD_FORWARD);
  });

  it("leaves Unix paths unchanged", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc(""));
    const tool = createGrepTool(UNIX_CWD);

    await tool.execute({ pattern: "foo", path: "/home/user/project/src" }, mockCtx);

    expect(capturedSearchPath(spy)).toBe("/home/user/project/src");
  });

  it("strips \\\\?\\ extended-length prefix from path", async () => {
    spy = spyOn(childProcess, "spawn").mockReturnValue(mockProc("file.ts:1:match\n"));
    const tool = createGrepTool(UNIX_CWD);

    await tool.execute({ pattern: "foo", path: "\\\\?\\C:\\Users\\alice\\git\\diligent" }, mockCtx);

    expect(capturedSearchPath(spy)).toBe(WIN_CWD_FORWARD);
  });

  it("rejects Windows filesystem root path with structured status", async () => {
    const tool = createGrepTool(UNIX_CWD);

    const result = await tool.execute({ pattern: "foo", path: "C:/" }, mockCtx);

    expect(result.output).toContain("refusing to grep the filesystem root");
    expect(result.metadata).toMatchObject({
      error: true,
      status: {
        kind: "invalid_scope",
        code: "filesystem_root",
        path: "C:/",
        retryable: false,
        actionable: true,
      },
    });
  });
});

describe("cross-platform path utilities", () => {
  it("resolves relative paths against Windows cwd using win32 semantics", () => {
    expect(resolveCrossPlatformPath(WIN_CWD_BACKSLASH, "packages\\runtime\\src")).toBe(
      "C:\\Users\\alice\\git\\diligent\\packages\\runtime\\src",
    );
  });

  it("resolves relative paths against extended-length Windows cwd", () => {
    expect(resolveCrossPlatformPath("\\\\?\\C:\\Users\\alice\\git\\diligent", "packages/runtime/src")).toBe(
      "C:\\Users\\alice\\git\\diligent\\packages\\runtime\\src",
    );
  });

  it("computes dirname for Windows paths on non-Windows hosts", () => {
    expect(dirnameCrossPlatform("C:/Users/alice/git/diligent/packages/runtime/src/index.ts")).toBe(
      "C:\\Users\\alice\\git\\diligent\\packages\\runtime\\src",
    );
  });

  it("computes relative paths for Windows paths on non-Windows hosts", () => {
    expect(relativeCrossPlatform(WIN_CWD_FORWARD, "C:/Users/alice/git/diligent/packages/runtime/src")).toBe(
      "packages\\runtime\\src",
    );
  });
});
