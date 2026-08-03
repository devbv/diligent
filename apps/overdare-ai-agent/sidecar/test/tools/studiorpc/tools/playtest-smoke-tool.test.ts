// @summary Tests the shallow hybrid playtest orchestration and its cleanup guarantees.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  DEFAULT_PLAYTEST_ACTIONS,
  type DesktopAction,
  type StudioDesktopAdapter,
} from "../../../../src/tools/studiorpc/tools/playtest-desktop";
import {
  createPlaytestGoalTool,
  createPlaytestSmokeTool,
  type PlaytestClock,
} from "../../../../src/tools/studiorpc/tools/playtest-smoke-tool";
import { createWriteLock } from "../../../../src/tools/studiorpc/write-lock";

const createdDirs: string[] = [];
const starterPlayerScriptsGuid = "starter-player-scripts-guid";
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function makeProject(): string {
  const cwd = join(tmpdir(), `sidecar-playtest-${process.pid}-${Date.now()}-${createdDirs.length}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "Test.umap"), "");
  writeFileSync(
    join(cwd, "Test.ovdrjm"),
    JSON.stringify(
      {
        MapObjectKeyIndex: 1,
        Root: {
          InstanceType: "Workspace",
          ActorGuid: "workspace-guid",
          Name: "Workspace",
          LuaChildren: [
            {
              InstanceType: "StarterPlayerScripts",
              ActorGuid: starterPlayerScriptsGuid,
              Name: "StarterPlayerScripts",
              LuaChildren: [],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  createdDirs.push(cwd);
  return cwd;
}

function browseResult(count = 1): unknown {
  return {
    level: Array.from({ length: count }, (_, index) => ({
      guid: index === 0 ? starterPlayerScriptsGuid : `${starterPlayerScriptsGuid}-${index}`,
      name: "StarterPlayerScripts",
      class: "StarterPlayerScripts",
    })),
  };
}

function marker(runId: string, ...parts: string[]): string {
  return `@@DILIGENT_PLAYTEST@@|${runId}|${parts.join("|")}`;
}

function fakeClock(): PlaytestClock {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
}

function toolContext(signal = new AbortController().signal) {
  return { toolCallId: "playtest", signal, abort: () => {}, approve: async () => "once" as const };
}

function makeDesktop(overrides: Partial<StudioDesktopAdapter> = {}): {
  adapter: StudioDesktopAdapter;
  calls: string[];
  actions: DesktopAction[][];
} {
  const calls: string[] = [];
  const actions: DesktopAction[][] = [];
  const adapter: StudioDesktopAdapter = {
    listWindows: async () => {
      calls.push("list");
      return [{ id: "101", title: "OVERDARE Studio", processName: "OVERDAREStudio" }];
    },
    capture: async ({ outputPath }) => {
      calls.push(`capture:${outputPath.split(/[\\/]/).pop()}`);
      writeFileSync(outputPath, tinyPng);
    },
    applyActions: async ({ actions: applied }) => {
      calls.push("input");
      actions.push(applied);
    },
    ...overrides,
  };
  return { adapter, calls, actions };
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("studio_playtest_smoke", () => {
  test("accepts bounded input timelines but never accepts goal or native-window fields", () => {
    const tool = createPlaytestSmokeTool({
      cwd: ".",
      writeLock: createWriteLock(),
      platform: "win32",
      desktop: makeDesktop().adapter,
      callRpc: async () => ({}),
    });

    expect(tool.description).toContain("W, A, S, D, and SPACE");
    expect(tool.description).toContain("Never provide `windowId`");
    expect(tool.parameters.safeParse({}).success).toBe(true);
    expect(
      tool.parameters.safeParse({
        actions: [
          { keys: ["W"], durationMs: 400 },
          { keys: ["W", "SPACE"], durationMs: 100 },
          { keys: ["D"], durationMs: 300 },
        ],
      }).success,
    ).toBe(true);
    expect(tool.parameters.safeParse({ windowId: "123" }).success).toBe(false);
    expect(tool.parameters.safeParse({ successMarker: "JUMP_GATE_COMPLETE" }).success).toBe(false);
    expect(tool.parameters.safeParse({ actions: [{ keys: ["Q"], durationMs: 100 }] }).success).toBe(false);
    expect(tool.parameters.safeParse({ actions: [{ keys: ["W", "W"], durationMs: 100 }] }).success).toBe(false);
    expect(tool.parameters.safeParse({ actions: [{ keys: ["W"], durationMs: 5_001 }] }).success).toBe(false);
    expect(
      tool.parameters.safeParse({
        actions: Array.from({ length: 4 }, () => ({ keys: ["W"], durationMs: 1_500 })),
      }).success,
    ).toBe(false);
    expect(zodToJsonSchema(tool.parameters)).toMatchObject({
      type: "object",
      properties: {
        actions: { type: "array" },
      },
      additionalProperties: false,
    });
  });

  test("exposes game-goal verification through a separate required-marker tool", () => {
    const tool = createPlaytestGoalTool({
      cwd: ".",
      writeLock: createWriteLock(),
      platform: "win32",
      desktop: makeDesktop().adapter,
      callRpc: async () => ({}),
    });

    expect(tool.name).toBe("studio_playtest_goal");
    expect(tool.description).toContain("successMarker");
    expect(tool.parameters.safeParse({}).success).toBe(false);
    expect(
      tool.parameters.safeParse({
        actions: [{ keys: ["W", "SPACE"], durationMs: 100 }],
        successMarker: "JUMP_GATE_COMPLETE",
      }).success,
    ).toBe(true);
    expect(
      tool.parameters.safeParse({
        actions: [{ keys: ["W"], durationMs: 100 }],
        successMarker: "marker with spaces",
      }).success,
    ).toBe(false);
    expect(tool.parameters.safeParse({ actions: [{ keys: ["W"], durationMs: 100 }] }).success).toBe(false);
    expect(tool.parameters.safeParse({ successMarker: "JUMP_GATE_COMPLETE", windowId: "123" }).success).toBe(false);
    expect(zodToJsonSchema(tool.parameters)).toMatchObject({
      type: "object",
      properties: {
        actions: { type: "array" },
        successMarker: { type: "string" },
      },
      required: ["actions", "successMarker"],
      additionalProperties: false,
    });
  });

  test("injects an observer, applies the default input sequence, returns two images, and cleans up", async () => {
    const cwd = makeProject();
    const rpcCalls: string[] = [];
    let approvals = 0;
    const desktop = makeDesktop({
      applyActions: async ({ actions }) => {
        desktop.calls.push("input");
        desktop.actions.push(actions);
        writeFileSync(
          join(cwd, "Play.log"),
          [
            marker("run-1", "ready"),
            marker("run-1", "input", "W", "begin"),
            marker("run-1", "input", "W", "end"),
            marker("run-1", "input", "SPACE", "begin"),
            marker("run-1", "input", "SPACE", "end"),
          ].join("\n"),
        );
      },
    });
    const tool = createPlaytestSmokeTool({
      cwd,
      writeLock: createWriteLock(),
      platform: "win32",
      clock: fakeClock(),
      createRunId: () => "run-1",
      desktop: desktop.adapter,
      callRpc: async (method) => {
        rpcCalls.push(method);
        if (method === "level.browse") return browseResult();
        if (method === "game.play") writeFileSync(join(cwd, "Play.log"), marker("run-1", "ready"));
        return {};
      },
    });

    const result = await tool.execute(
      {},
      {
        ...toolContext(),
        approve: async () => {
          approvals++;
          return "once" as const;
        },
      },
    );

    expect(result.metadata).toMatchObject({
      status: "PASS",
      runId: "run-1",
      cleanupSucceeded: true,
      observedInputs: ["W:begin", "W:end", "SPACE:begin", "SPACE:end"],
    });
    expect(result.outputImages).toHaveLength(2);
    expect(approvals).toBe(1);
    expect(result.outputImages?.every((image) => image.source.media_type === "image/png")).toBe(true);
    expect(desktop.calls).toEqual(["list", "capture:before.png", "input", "capture:after.png"]);
    expect(desktop.actions).toEqual([DEFAULT_PLAYTEST_ACTIONS]);
    expect(rpcCalls).toEqual(["level.browse", "level.apply", "game.play", "game.stop", "level.apply"]);

    const ovdrjm = readFileSync(join(cwd, "Test.ovdrjm"), "utf8");
    expect(ovdrjm).not.toContain("__DiligentPlaytestObserver_run-1");

    const runDir = join(cwd, ".diligent", "playtests", "runs", "run-1");
    expect(JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"))).toMatchObject({
      status: "PASS",
      cleanupSucceeded: true,
    });
    expect(readFileSync(join(runDir, "trace.jsonl"), "utf8")).toContain('"event":"observer.ready"');
  });

  test("applies a dynamic input timeline and requires the requested game success marker", async () => {
    const cwd = makeProject();
    const desktop = makeDesktop({
      applyActions: async ({ actions }) => {
        desktop.calls.push("input");
        desktop.actions.push(actions);
        writeFileSync(
          join(cwd, "Play.log"),
          [
            marker("dynamic", "ready"),
            marker("dynamic", "input", "W", "begin"),
            marker("dynamic", "input", "SPACE", "begin"),
            marker("dynamic", "input", "SPACE", "end"),
            marker("dynamic", "input", "W", "end"),
            marker("dynamic", "input", "D", "begin"),
            marker("dynamic", "input", "D", "end"),
            "JUMP_GATE_COMPLETE",
          ].join("\n"),
        );
      },
    });
    const tool = createPlaytestGoalTool({
      cwd,
      writeLock: createWriteLock(),
      platform: "win32",
      clock: fakeClock(),
      createRunId: () => "dynamic",
      desktop: desktop.adapter,
      callRpc: async (method) => {
        if (method === "level.browse") return browseResult();
        if (method === "game.play") writeFileSync(join(cwd, "Play.log"), marker("dynamic", "ready"));
        return {};
      },
    });
    const actions = [
      { keys: ["W"] as const, durationMs: 400 },
      { keys: ["W", "SPACE"] as const, durationMs: 100 },
      { keys: ["W"] as const, durationMs: 300 },
      { keys: ["D"] as const, durationMs: 200 },
    ];

    const result = await tool.execute({ actions, successMarker: "JUMP_GATE_COMPLETE" }, toolContext());

    expect(result.metadata).toMatchObject({
      status: "PASS",
      runId: "dynamic",
      requiredInputs: ["W:begin", "SPACE:begin", "SPACE:end", "W:end", "D:begin", "D:end"],
      observedInputs: ["W:begin", "SPACE:begin", "SPACE:end", "W:end", "D:begin", "D:end"],
      successMarker: "JUMP_GATE_COMPLETE",
      successMarkerObserved: true,
      cleanupSucceeded: true,
    });
    expect(desktop.actions).toEqual([
      [
        { type: "click_center" },
        { type: "set_keys", keys: ["W"], durationMs: 400 },
        { type: "set_keys", keys: ["W", "SPACE"], durationMs: 100 },
        { type: "set_keys", keys: ["W"], durationMs: 300 },
        { type: "set_keys", keys: ["D"], durationMs: 200 },
      ],
    ]);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "PASS",
      successMarker: "JUMP_GATE_COMPLETE",
      successMarkerObserved: true,
    });
  });

  test("classifies a missing game success marker separately from an input harness failure", async () => {
    const cwd = makeProject();
    const desktop = makeDesktop({
      applyActions: async () => {
        desktop.calls.push("input");
        writeFileSync(
          join(cwd, "Play.log"),
          [
            marker("goal-missing", "ready"),
            marker("goal-missing", "input", "A", "begin"),
            marker("goal-missing", "input", "A", "end"),
          ].join("\n"),
        );
      },
    });
    const tool = createPlaytestGoalTool({
      cwd,
      writeLock: createWriteLock(),
      platform: "win32",
      clock: fakeClock(),
      createRunId: () => "goal-missing",
      desktop: desktop.adapter,
      callRpc: async (method) => {
        if (method === "level.browse") return browseResult();
        if (method === "game.play") writeFileSync(join(cwd, "Play.log"), marker("goal-missing", "ready"));
        return {};
      },
    });

    const result = await tool.execute(
      { actions: [{ keys: ["A"], durationMs: 100 }], successMarker: "LEVEL_COMPLETE" },
      toolContext(),
    );

    expect(result.metadata).toMatchObject({
      status: "FAIL",
      failureCode: "GOAL_NOT_OBSERVED",
      observedInputs: ["A:begin", "A:end"],
      successMarker: "LEVEL_COMPLETE",
      successMarkerObserved: false,
      cleanupSucceeded: true,
    });
    expect(result.outputImages).toHaveLength(2);
  });

  test("does not mutate the project when StarterPlayerScripts is missing or duplicated", async () => {
    for (const count of [0, 2]) {
      const cwd = makeProject();
      const before = readFileSync(join(cwd, "Test.ovdrjm"), "utf8");
      const rpcCalls: string[] = [];
      const tool = createPlaytestSmokeTool({
        cwd,
        writeLock: createWriteLock(),
        platform: "win32",
        clock: fakeClock(),
        createRunId: () => `missing-${count}`,
        desktop: makeDesktop().adapter,
        callRpc: async (method) => {
          rpcCalls.push(method);
          return method === "level.browse" ? browseResult(count) : {};
        },
      });

      const result = await tool.execute({}, toolContext());

      expect(result.metadata).toMatchObject({
        status: "FAIL",
        failureCode: "STARTER_PLAYER_SCRIPTS_NOT_FOUND",
      });
      expect(readFileSync(join(cwd, "Test.ovdrjm"), "utf8")).toBe(before);
      expect(rpcCalls).toEqual(["level.browse"]);
    }
  });

  test("stops play and removes the observer when the ready marker times out", async () => {
    const cwd = makeProject();
    const rpcCalls: string[] = [];
    const tool = createPlaytestSmokeTool({
      cwd,
      writeLock: createWriteLock(),
      platform: "win32",
      clock: fakeClock(),
      createRunId: () => "not-ready",
      desktop: makeDesktop().adapter,
      callRpc: async (method) => {
        rpcCalls.push(method);
        if (method === "level.browse") return browseResult();
        return {};
      },
    });

    const result = await tool.execute({}, toolContext());

    expect(result.metadata).toMatchObject({
      status: "FAIL",
      failureCode: "OBSERVER_NOT_READY",
      cleanupSucceeded: true,
    });
    expect(rpcCalls).toEqual(["level.browse", "level.apply", "game.play", "game.stop", "level.apply"]);
    expect(readFileSync(join(cwd, "Test.ovdrjm"), "utf8")).not.toContain("__DiligentPlaytestObserver_not-ready");
  });

  test("refuses ambiguous windows before input and still cleans up", async () => {
    const cwd = makeProject();
    const desktop = makeDesktop({
      listWindows: async () => [
        { id: "101", title: "OVERDARE Studio", processName: "OVERDAREStudio" },
        { id: "102", title: "OVERDARE Client", processName: "OVERDAREClient" },
      ],
    });
    const tool = createPlaytestSmokeTool({
      cwd,
      writeLock: createWriteLock(),
      platform: "win32",
      clock: fakeClock(),
      createRunId: () => "ambiguous",
      desktop: desktop.adapter,
      callRpc: async (method) => {
        if (method === "level.browse") return browseResult();
        if (method === "game.play") writeFileSync(join(cwd, "Play.log"), marker("ambiguous", "ready"));
        return {};
      },
    });

    const result = await tool.execute({}, toolContext());

    expect(result.metadata).toMatchObject({
      status: "FAIL",
      failureCode: "AMBIGUOUS_STUDIO_WINDOWS",
      cleanupSucceeded: true,
    });
    expect(desktop.calls).not.toContain("input");
  });

  test("reports missing windows and capture failures without leaking the observer", async () => {
    for (const scenario of ["missing-window", "capture-failed"] as const) {
      const cwd = makeProject();
      const desktop = makeDesktop(
        scenario === "missing-window"
          ? { listWindows: async () => [] }
          : {
              capture: async () => {
                throw new Error("capture failed");
              },
            },
      );
      const tool = createPlaytestSmokeTool({
        cwd,
        writeLock: createWriteLock(),
        platform: "win32",
        clock: fakeClock(),
        createRunId: () => scenario,
        desktop: desktop.adapter,
        callRpc: async (method) => {
          if (method === "level.browse") return browseResult();
          if (method === "game.play") writeFileSync(join(cwd, "Play.log"), marker(scenario, "ready"));
          return {};
        },
      });

      const result = await tool.execute({}, toolContext());

      expect(result.metadata).toMatchObject({
        status: "FAIL",
        failureCode: scenario === "missing-window" ? "STUDIO_WINDOW_NOT_FOUND" : "CAPTURE_FAILED",
        cleanupSucceeded: true,
      });
      expect(readFileSync(join(cwd, "Test.ovdrjm"), "utf8")).not.toContain(`__DiligentPlaytestObserver_${scenario}`);
    }
  });

  test("fails when input markers are incomplete but preserves the captured evidence", async () => {
    const cwd = makeProject();
    const desktop = makeDesktop({
      applyActions: async () => {
        desktop.calls.push("input");
        writeFileSync(
          join(cwd, "Play.log"),
          [marker("partial", "ready"), marker("partial", "input", "W", "begin")].join("\n"),
        );
      },
    });
    const tool = createPlaytestSmokeTool({
      cwd,
      writeLock: createWriteLock(),
      platform: "win32",
      clock: fakeClock(),
      createRunId: () => "partial",
      desktop: desktop.adapter,
      callRpc: async (method) => {
        if (method === "level.browse") return browseResult();
        if (method === "game.play") writeFileSync(join(cwd, "Play.log"), marker("partial", "ready"));
        return {};
      },
    });

    const result = await tool.execute({}, toolContext());

    expect(result.metadata).toMatchObject({
      status: "FAIL",
      failureCode: "INPUT_NOT_OBSERVED",
      cleanupSucceeded: true,
      observedInputs: ["W:begin"],
    });
    expect(result.outputImages).toHaveLength(2);
  });

  test("reports interruption and cleanup failure with stable failure codes", async () => {
    const interruptedCwd = makeProject();
    const controller = new AbortController();
    const interruptedDesktop = makeDesktop({
      listWindows: async () => {
        controller.abort();
        return [{ id: "101", title: "OVERDARE Studio", processName: "OVERDAREStudio" }];
      },
    });
    const interruptedTool = createPlaytestSmokeTool({
      cwd: interruptedCwd,
      writeLock: createWriteLock(),
      platform: "win32",
      clock: fakeClock(),
      createRunId: () => "interrupted",
      desktop: interruptedDesktop.adapter,
      callRpc: async (method) => {
        if (method === "level.browse") return browseResult();
        if (method === "game.play") writeFileSync(join(interruptedCwd, "Play.log"), marker("interrupted", "ready"));
        return {};
      },
    });

    const interrupted = await interruptedTool.execute({}, toolContext(controller.signal));
    expect(interrupted.metadata).toMatchObject({
      status: "FAIL",
      failureCode: "INTERRUPTED",
      cleanupSucceeded: true,
    });

    const cleanupCwd = makeProject();
    const cleanupTool = createPlaytestSmokeTool({
      cwd: cleanupCwd,
      writeLock: createWriteLock(),
      platform: "win32",
      clock: fakeClock(),
      createRunId: () => "cleanup-failed",
      desktop: makeDesktop().adapter,
      callRpc: async (method) => {
        if (method === "level.browse") return browseResult();
        if (method === "game.play") writeFileSync(join(cleanupCwd, "Play.log"), marker("cleanup-failed", "ready"));
        if (method === "game.stop") throw new Error("stop failed");
        return {};
      },
    });

    const cleanupFailed = await cleanupTool.execute({}, toolContext());
    expect(cleanupFailed.metadata).toMatchObject({
      status: "FAIL",
      failureCode: "CLEANUP_FAILED",
      cleanupSucceeded: false,
    });
  });

  test("returns unsupported platform without requesting approval or writing artifacts", async () => {
    const cwd = makeProject();
    let approvals = 0;
    const tool = createPlaytestSmokeTool({
      cwd,
      writeLock: createWriteLock(),
      platform: "darwin",
      createRunId: () => "unsupported",
      desktop: makeDesktop().adapter,
      callRpc: async () => {
        throw new Error("RPC should not be called");
      },
    });

    const result = await tool.execute({}, {
      ...toolContext(),
      approve: async () => {
        approvals++;
        return "once" as const;
      },
    } as never);

    expect(result.metadata).toMatchObject({
      status: "FAIL",
      failureCode: "UNSUPPORTED_PLATFORM",
    });
    expect(approvals).toBe(0);
    expect(Bun.file(join(cwd, ".diligent", "playtests", "runs", "unsupported", "report.json")).exists()).resolves.toBe(
      false,
    );
  });
});
