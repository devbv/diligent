// @summary Tests OVERDARE tool CLI command parsing and bundled tool dispatch.

import { beforeEach, describe, expect, mock, test } from "bun:test";

const levelBrowseMock = mock(async () => [
  { guid: "WORKSPACE_GUID", name: "Workspace", class: "Folder", children: [] },
]);

mock.module("../../sidecar/src/tools/studiorpc/rpc.ts", () => ({
  applyLevelChanges: async () => ({ ok: true }),
  call: (method: string) => {
    if (method === "level.browse") return levelBrowseMock();
    if (method === "level.save.file") return Promise.resolve("World file saved.");
    throw new Error(`Unexpected RPC method in test: ${method}`);
  },
}));

const { parseCliArgs, runOverdareToolsCli } = await import("../../scripts/lib/overdare-tools-cli.ts");

function createStreams() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    streams: {
      stdout: {
        log: (text: string) => stdout.push(text),
      },
      stderr: {
        error: (text: string) => stderr.push(text),
        write: (text: string) => stderr.push(text),
      },
    },
  };
}

describe("overdare tool cli", () => {
  beforeEach(() => {
    levelBrowseMock.mockClear();
  });

  test("parseCliArgs accepts run command with cwd and json flags", () => {
    const parsed = parseCliArgs([
      "run",
      "studiorpc_level_browse",
      "--args",
      "{}",
      "--cwd",
      "/tmp/project",
      "--json",
      "--yes",
    ]);

    expect(parsed).toMatchObject({
      command: "run",
      toolName: "studiorpc_level_browse",
      args: "{}",
      cwd: "/tmp/project",
      json: true,
      yes: true,
    });
  });

  test("list command prints bundled provider source names", async () => {
    const { stdout, streams } = createStreams();

    const exitCode = await runOverdareToolsCli(["list"], streams);

    expect(exitCode).toBe(0);
    expect(stdout.some((line) => line.includes("[studiorpc]"))).toBe(true);
    expect(stdout.some((line) => line.includes("[validator]"))).toBe(true);
  });

  test("inspect returns schema and source in json mode", async () => {
    const { stdout, streams } = createStreams();

    const exitCode = await runOverdareToolsCli(["inspect", "studiorpc_level_browse", "--json"], streams);

    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout.join("\n")) as { source: string; name: string };
    expect(payload.name).toBe("studiorpc_level_browse");
    expect(payload.source).toBe("studiorpc");
  });

  test("run executes a bundled tool and returns structured json", async () => {
    const { stdout, streams } = createStreams();

    const exitCode = await runOverdareToolsCli(["run", "studiorpc_level_browse", "--args", "{}", "--json"], streams);

    expect(exitCode).toBe(0);
    expect(levelBrowseMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(stdout.join("\n")) as {
      tool: string;
      source: string;
      result: { output: string; metadata?: { method?: string } };
    };
    expect(payload.tool).toBe("studiorpc_level_browse");
    expect(payload.source).toBe("studiorpc");
    expect(payload.result.metadata?.method).toBe("level.browse");
  });

  test("unknown tools return a failing exit code", async () => {
    const { stderr, streams } = createStreams();

    const exitCode = await runOverdareToolsCli(["inspect", "missing_tool"], streams);

    expect(exitCode).toBe(1);
    expect(stderr[0]).toContain("Unknown tool");
  });
});
