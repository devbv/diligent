// @summary Tests bounded temporary Luau playtest drivers, evidence, failure classification, and cleanup.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  createPlaytestScriptedTool,
  type ScriptedPlaytestClock,
} from "../../../../src/tools/studiorpc/tools/playtest-scripted-tool";
import { createWriteLock } from "../../../../src/tools/studiorpc/write-lock";

const createdDirs: string[] = [];
const starterPlayerScriptsGuid = "starter-player-scripts-guid";

function makeProject(): string {
  const cwd = join(tmpdir(), `sidecar-scripted-playtest-${process.pid}-${Date.now()}-${createdDirs.length}`);
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

function browseProject(cwd: string): unknown {
  const document = JSON.parse(readFileSync(join(cwd, "Test.ovdrjm"), "utf8")) as {
    Root: {
      ActorGuid: string;
      Name: string;
      InstanceType: string;
      LuaChildren?: unknown[];
    };
  };
  const visit = (node: unknown): unknown => {
    const value = node as {
      ActorGuid: string;
      Name: string;
      InstanceType: string;
      LuaChildren?: unknown[];
    };
    return {
      guid: value.ActorGuid,
      name: value.Name,
      class: value.InstanceType,
      children: (value.LuaChildren ?? []).map(visit),
    };
  };
  return { level: [visit(document.Root)] };
}

function marker(runId: string, ...parts: string[]): string {
  return `@@DILIGENT_SCRIPTED_PLAYTEST@@|${runId}|${parts.join("|")}`;
}

function fakeClock(): ScriptedPlaytestClock {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
}

function toolContext(signal = new AbortController().signal) {
  return { toolCallId: "scripted-playtest", signal, abort: () => {}, approve: async () => "once" as const };
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("studio_playtest_scripted", () => {
  test("exposes a bounded temporary-driver contract without native-window fields", () => {
    const tool = createPlaytestScriptedTool({
      cwd: ".",
      writeLock: createWriteLock(),
      callRpc: async () => ({}),
    });

    expect(tool.name).toBe("studio_playtest_scripted");
    expect(tool.description).toContain("temporary client Luau driver");
    expect(tool.description).toContain("awaitCharacter");
    expect(tool.description).toContain("stable playable state");
    expect(tool.description).toContain("awaitSpawnedCharacter");
    expect(tool.description).toContain("awaitPlayableCharacter");
    expect(tool.description).toContain("moveCharacterTo");
    expect(tool.description).toContain("waitUntil");
    expect(tool.description).toContain("does not prove real player input");
    expect(
      tool.parameters.safeParse({
        driverSource: 'checkpoint("TARGET_FOUND")\nreturn true',
        expectedCheckpoints: ["TARGET_FOUND"],
        successMarker: "TARGET_DESTROYED",
        timeoutMs: 12_000,
      }).success,
    ).toBe(true);
    expect(tool.parameters.safeParse({}).success).toBe(false);
    expect(
      tool.parameters.safeParse({
        driverSource: 'print("TARGET_DESTROYED")',
        expectedCheckpoints: ["TARGET_FOUND"],
        successMarker: "TARGET_DESTROYED",
      }).success,
    ).toBe(false);
    expect(
      tool.parameters.safeParse({
        driverSource: 'print("@@DILIGENT_SCRIPTED_PLAYTEST@@")',
        expectedCheckpoints: ["TARGET_FOUND"],
        successMarker: "TARGET_DESTROYED",
      }).success,
    ).toBe(false);
    expect(
      tool.parameters.safeParse({
        driverSource: 'checkpoint("TARGET FOUND")',
        expectedCheckpoints: ["TARGET FOUND"],
        successMarker: "TARGET_DESTROYED",
      }).success,
    ).toBe(false);
    expect(
      tool.parameters.safeParse({
        driverSource: 'checkpoint("TARGET_FOUND")',
        expectedCheckpoints: ["TARGET_FOUND"],
        successMarker: "TARGET_DESTROYED",
        timeoutMs: 30_001,
      }).success,
    ).toBe(false);
    expect(
      tool.parameters.safeParse({
        driverSource: 'checkpoint("TARGET_FOUND")',
        expectedCheckpoints: ["TARGET_FOUND"],
        successMarker: "TARGET_DESTROYED",
        windowId: "123",
      }).success,
    ).toBe(false);
    expect(zodToJsonSchema(tool.parameters)).toMatchObject({
      type: "object",
      properties: {
        driverSource: { type: "string" },
        expectedCheckpoints: { type: "array" },
        successMarker: { type: "string" },
        timeoutMs: { type: "integer" },
      },
      required: ["driverSource", "expectedCheckpoints", "successMarker"],
      additionalProperties: false,
    });
  });

  test("runs a complex driver once, verifies ordered checkpoints and the real game marker, then cleans up", async () => {
    const cwd = makeProject();
    const rpcCalls: string[] = [];
    let injectedSource = "";
    let approvals = 0;
    const tool = createPlaytestScriptedTool({
      cwd,
      writeLock: createWriteLock(),
      clock: fakeClock(),
      createRunId: () => "scripted-pass",
      callRpc: async (method) => {
        rpcCalls.push(method);
        if (method === "level.browse") return browseProject(cwd);
        if (method === "level.apply" && !injectedSource) {
          injectedSource = readFileSync(join(cwd, "Test.ovdrjm"), "utf8");
        }
        if (method === "game.play") {
          writeFileSync(
            join(cwd, "Play.log"),
            [
              marker("scripted-pass", "driver", "ready"),
              marker("scripted-pass", "checkpoint", "TARGET_ACQUIRED"),
              marker("scripted-pass", "checkpoint", "WEAPON_FIRED"),
              "TARGET_DESTROYED",
              marker("scripted-pass", "driver", "complete"),
            ].join("\n"),
          );
        }
        return {};
      },
    });
    const driverSource = [
      'checkpoint("TARGET_ACQUIRED")',
      'local weapon = game:GetService("ReplicatedStorage"):FindFirstChild("Weapon")',
      'checkpoint("WEAPON_FIRED")',
      "return weapon ~= nil",
    ].join("\n");

    const result = await tool.execute(
      {
        driverSource,
        expectedCheckpoints: ["TARGET_ACQUIRED", "WEAPON_FIRED"],
        successMarker: "TARGET_DESTROYED",
      },
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
      runId: "scripted-pass",
      expectedCheckpoints: ["TARGET_ACQUIRED", "WEAPON_FIRED"],
      observedCheckpoints: ["TARGET_ACQUIRED", "WEAPON_FIRED"],
      driverCompleted: true,
      successMarker: "TARGET_DESTROYED",
      successMarkerObserved: true,
      cleanupSucceeded: true,
    });
    expect(approvals).toBe(1);
    expect(rpcCalls).toEqual(["level.browse", "level.apply", "level.browse", "game.play", "game.stop", "level.apply"]);
    expect(injectedSource).toContain("__DiligentScriptedPlaytest_scripted-pass");
    expect(injectedSource).toContain("xpcall(function()");
    expect(injectedSource).toContain("local function checkpoint(value)");
    expect(injectedSource).toContain("local function awaitSpawnedCharacter(timeoutSeconds)");
    expect(injectedSource).toContain("local function awaitPlayableCharacter(timeoutSeconds)");
    expect(injectedSource).toContain("local character = awaitSpawnedCharacter(timeout)");
    expect(injectedSource).toContain("local spawnGraceSeconds = math.min(1.5, timeout / 2)");
    expect(injectedSource).toContain("task.wait(spawnGraceSeconds)");
    expect(injectedSource).toContain("local verticalPositionDelta = math.abs(rootPart.Position.Y - previousY)");
    expect(injectedSource).toContain("return settledSamples >= 5");
    expect(injectedSource).toContain("local function awaitCharacter(timeoutSeconds)");
    expect(injectedSource).toContain("local character = awaitPlayableCharacter(timeoutSeconds)");
    expect(injectedSource).toContain(
      "local function moveCharacterTo(humanoid, rootPart, destination, timeoutSeconds, horizontalTolerance, verticalTolerance)",
    );
    expect(injectedSource).toContain(
      "destinationPosition = Vector3.new(destination.Position.X, rootPart.Position.Y, destination.Position.Z)",
    );
    expect(injectedSource).toContain(
      'MoveToFinished timed out: root=\\" .. formatVector3(rootPart.Position) .. \\" target=\\" .. formatVector3(destinationPosition)',
    );
    expect(injectedSource).toContain("local function currentPositionError()");
    expect(injectedSource).toContain(
      "return reached or (horizontalError <= allowedHorizontalError and verticalError <= allowedVerticalError)",
    );
    expect(injectedSource).toContain("Enum.HumanoidStateType.Freefall");
    expect(injectedSource).toContain("rootPart.AssemblyLinearVelocity.Y");
    expect(injectedSource).toContain("local horizontalError = math.sqrt(delta.X * delta.X + delta.Z * delta.Z)");
    expect(injectedSource).toContain("character is airborne after MoveTo");
    expect(injectedSource).toContain("local function waitUntil(predicate, timeoutSeconds, intervalSeconds)");
    expect(injectedSource).toContain('checkpoint(\\"TARGET_ACQUIRED\\")');
    expect(injectedSource).toContain('checkpoint(\\"WEAPON_FIRED\\")');
    expect(readFileSync(join(cwd, "Test.ovdrjm"), "utf8")).not.toContain("__DiligentScriptedPlaytest_scripted-pass");

    const runDir = join(cwd, ".diligent", "playtests", "runs", "scripted-pass");
    expect(readFileSync(join(runDir, "driver.luau"), "utf8")).toBe(`${driverSource}\n`);
    expect(readFileSync(join(runDir, "play.log"), "utf8")).toContain("TARGET_DESTROYED");
    expect(JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"))).toMatchObject({
      kind: "scripted",
      status: "PASS",
      driver: { bytes: Buffer.byteLength(driverSource, "utf8") },
    });
    expect(readFileSync(join(runDir, "trace.jsonl"), "utf8")).toContain('"event":"driver.completed"');
  });

  test.each([
    {
      name: "driver error",
      lines: [marker("classified", "driver", "ready"), marker("classified", "driver", "error", "missing-weapon")],
      expectedCode: "DRIVER_FAILED",
    },
    {
      name: "missing checkpoint",
      lines: [
        marker("classified", "driver", "ready"),
        marker("classified", "checkpoint", "TARGET_ACQUIRED"),
        "TARGET_DESTROYED",
        marker("classified", "driver", "complete"),
      ],
      expectedCode: "CHECKPOINTS_NOT_OBSERVED",
    },
    {
      name: "missing goal",
      lines: [
        marker("classified", "driver", "ready"),
        marker("classified", "checkpoint", "TARGET_ACQUIRED"),
        marker("classified", "checkpoint", "WEAPON_FIRED"),
        marker("classified", "driver", "complete"),
      ],
      expectedCode: "GOAL_NOT_OBSERVED",
    },
  ])("classifies $name separately", async ({ lines, expectedCode }) => {
    const cwd = makeProject();
    const tool = createPlaytestScriptedTool({
      cwd,
      writeLock: createWriteLock(),
      clock: fakeClock(),
      createRunId: () => "classified",
      callRpc: async (method) => {
        if (method === "level.browse") return browseProject(cwd);
        if (method === "game.play") writeFileSync(join(cwd, "Play.log"), lines.join("\n"));
        return {};
      },
    });

    const result = await tool.execute(
      {
        driverSource: 'checkpoint("TARGET_ACQUIRED")\ncheckpoint("WEAPON_FIRED")',
        expectedCheckpoints: ["TARGET_ACQUIRED", "WEAPON_FIRED"],
        successMarker: "TARGET_DESTROYED",
        timeoutMs: 1_000,
      },
      toolContext(),
    );

    expect(result.metadata).toMatchObject({
      status: "FAIL",
      failureCode: expectedCode,
      cleanupSucceeded: true,
    });
  });

  test("reports a bounded timeout and still removes the temporary driver", async () => {
    const cwd = makeProject();
    const tool = createPlaytestScriptedTool({
      cwd,
      writeLock: createWriteLock(),
      clock: fakeClock(),
      createRunId: () => "driver-timeout",
      callRpc: async (method) => {
        if (method === "level.browse") return browseProject(cwd);
        if (method === "game.play") {
          writeFileSync(join(cwd, "Play.log"), marker("driver-timeout", "driver", "ready"));
        }
        return {};
      },
    });

    const result = await tool.execute(
      {
        driverSource: 'checkpoint("WAITING")\nwhile true do task.wait() end',
        expectedCheckpoints: ["WAITING"],
        successMarker: "SCENARIO_COMPLETE",
        timeoutMs: 1_000,
      },
      toolContext(),
    );

    expect(result.metadata).toMatchObject({
      status: "FAIL",
      failureCode: "DRIVER_TIMEOUT",
      driverCompleted: false,
      cleanupSucceeded: true,
    });
    expect(readFileSync(join(cwd, "Test.ovdrjm"), "utf8")).not.toContain("__DiligentScriptedPlaytest_driver-timeout");
  });

  test("does not start play before the injected driver is visible in Studio", async () => {
    const cwd = makeProject();
    const rpcCalls: string[] = [];
    const tool = createPlaytestScriptedTool({
      cwd,
      writeLock: createWriteLock(),
      clock: fakeClock(),
      createRunId: () => "driver-not-applied",
      callRpc: async (method) => {
        rpcCalls.push(method);
        if (method === "level.browse") return browseResult();
        return {};
      },
    });

    const result = await tool.execute(
      {
        driverSource: 'checkpoint("TARGET_ACQUIRED")',
        expectedCheckpoints: ["TARGET_ACQUIRED"],
        successMarker: "TARGET_DESTROYED",
        timeoutMs: 1_000,
      },
      toolContext(),
    );

    expect(result.metadata).toMatchObject({
      status: "FAIL",
      failureCode: "DRIVER_NOT_READY",
      successMarkerObserved: false,
      cleanupSucceeded: true,
    });
    expect(rpcCalls).not.toContain("game.play");
    expect(readFileSync(join(cwd, "Test.ovdrjm"), "utf8")).not.toContain(
      "__DiligentScriptedPlaytest_driver-not-applied",
    );
  });

  test("does not credit a stale success marker when Studio play does not start", async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "Play.log"), "TARGET_DESTROYED\n");
    const tool = createPlaytestScriptedTool({
      cwd,
      writeLock: createWriteLock(),
      clock: fakeClock(),
      createRunId: () => "play-not-started",
      callRpc: async (method) => {
        if (method === "level.browse") return browseProject(cwd);
        return {};
      },
    });

    const result = await tool.execute(
      {
        driverSource: 'checkpoint("TARGET_ACQUIRED")',
        expectedCheckpoints: ["TARGET_ACQUIRED"],
        successMarker: "TARGET_DESTROYED",
        timeoutMs: 1_000,
      },
      toolContext(),
    );

    expect(result.metadata).toMatchObject({
      status: "FAIL",
      failureCode: "PLAY_NOT_STARTED",
      observedCheckpoints: [],
      driverCompleted: false,
      successMarkerObserved: false,
      cleanupSucceeded: true,
    });
    expect(readFileSync(join(cwd, ".diligent", "playtests", "runs", "play-not-started", "play.log"), "utf8")).toBe("");
  });

  test("searches for the success marker only in log output produced by the current run", async () => {
    const cwd = makeProject();
    const staleLog = "TARGET_DESTROYED\n";
    writeFileSync(join(cwd, "Play.log"), staleLog);
    const tool = createPlaytestScriptedTool({
      cwd,
      writeLock: createWriteLock(),
      clock: fakeClock(),
      createRunId: () => "stale-goal",
      callRpc: async (method) => {
        if (method === "level.browse") return browseProject(cwd);
        if (method === "game.play") {
          writeFileSync(
            join(cwd, "Play.log"),
            [
              staleLog.trimEnd(),
              marker("stale-goal", "driver", "ready"),
              marker("stale-goal", "checkpoint", "TARGET_ACQUIRED"),
              marker("stale-goal", "driver", "complete"),
            ].join("\n"),
          );
        }
        return {};
      },
    });

    const result = await tool.execute(
      {
        driverSource: 'checkpoint("TARGET_ACQUIRED")',
        expectedCheckpoints: ["TARGET_ACQUIRED"],
        successMarker: "TARGET_DESTROYED",
        timeoutMs: 1_000,
      },
      toolContext(),
    );

    expect(result.metadata).toMatchObject({
      status: "FAIL",
      failureCode: "GOAL_NOT_OBSERVED",
      observedCheckpoints: ["TARGET_ACQUIRED"],
      driverCompleted: true,
      successMarkerObserved: false,
      cleanupSucceeded: true,
    });
    expect(readFileSync(join(cwd, ".diligent", "playtests", "runs", "stale-goal", "play.log"), "utf8")).not.toContain(
      "TARGET_DESTROYED",
    );
  });

  test("does not mutate or create artifacts when execution approval is rejected", async () => {
    const cwd = makeProject();
    const before = readFileSync(join(cwd, "Test.ovdrjm"), "utf8");
    let rpcCalls = 0;
    const tool = createPlaytestScriptedTool({
      cwd,
      writeLock: createWriteLock(),
      createRunId: () => "rejected",
      callRpc: async () => {
        rpcCalls++;
        return {};
      },
    });

    const result = await tool.execute(
      {
        driverSource: 'checkpoint("READY")',
        expectedCheckpoints: ["READY"],
        successMarker: "SCENARIO_COMPLETE",
      },
      { ...toolContext(), approve: async () => "reject" as const },
    );

    expect(result.metadata).toMatchObject({ error: true, rejected: true });
    expect(rpcCalls).toBe(0);
    expect(readFileSync(join(cwd, "Test.ovdrjm"), "utf8")).toBe(before);
    expect(existsSync(join(cwd, ".diligent", "playtests", "runs", "rejected"))).toBe(false);
  });
});
