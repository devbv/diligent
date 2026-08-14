// @summary Tests the play-test input tools: target resolution, batch rules, and moveTo waiting.

import { describe, expect, test } from "bun:test";
import type { Tool } from "@diligent/core/tool-contract";
import { createStudioRpcToolProvider } from "../../../../src/tools/studiorpc";
import { createPieInputTools } from "../../../../src/tools/studiorpc/tools/pie-input";

interface RpcCall {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

type RpcHandler = (call: RpcCall, index: number) => unknown;

function runningStatus(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    running: true,
    state: "playing",
    pieSessionId: "pie-1",
    mode: "singleProcess",
    scope: "currentProcess",
    clients: [
      {
        clientId: "client-0",
        clientIndex: 0,
        pieInstance: 0,
        processId: 1,
        netMode: "Standalone",
        ready: false,
        injectable: false,
      },
      {
        clientId: "client-1",
        clientIndex: 1,
        pieInstance: 1,
        processId: 1,
        netMode: "Client",
        ready: true,
        injectable: true,
      },
    ],
    capabilities: { multiProcess: false, crossRequestHeldInput: false, mouseDeltaRequiresCapture: true },
    ...overrides,
  };
}

function fakeRpc(handler: RpcHandler) {
  const calls: RpcCall[] = [];
  const callRpc = async (method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => {
    const call: RpcCall = { method, params, timeoutMs: options?.timeoutMs };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { calls, callRpc };
}

function toolsFor(handler: RpcHandler) {
  const { calls, callRpc } = fakeRpc(handler);
  const byName = new Map(createPieInputTools(callRpc).map((tool) => [tool.name, tool]));
  return { calls, byName };
}

const ctx = { toolCallId: "test", signal: new AbortController().signal, abort: () => {} };

function run(tool: Tool | undefined, args: unknown) {
  if (!tool) throw new Error("tool not registered");
  return tool.execute(args as never, ctx as never);
}

const walkForward = [
  { type: "key", key: "W", action: "down" },
  { type: "wait", durationMs: 800 },
  { type: "key", key: "W", action: "up" },
];

describe("play-test input tools", () => {
  test("are registered on the Studio RPC provider", async () => {
    const provider = createStudioRpcToolProvider({ callRpc: async () => ({}) });
    const names = (await provider.createTools({ cwd: "/tmp/project" })).map((tool) => tool.name);

    expect(names).toContain("studiorpc_game_pie_status");
    expect(names).toContain("studiorpc_game_input_inject");
    expect(names).toContain("studiorpc_game_character_move_to");
    expect(names).toContain("studiorpc_game_character_move_status");
    // No release tool: Studio releases on sequence end, connection close, PIE end, and
    // physical input, and releaseAll only reaches the calling connection's own sequence.
    expect(names).not.toContain("studiorpc_game_input_release_all");
  });

  test("inject resolves the live session and first injectable client when ids are omitted", async () => {
    const { calls, byName } = toolsFor((call) =>
      call.method === "game.pie.status"
        ? runningStatus()
        : { sequenceId: "seq-1", status: "completed", appliedEventCount: 3 },
    );

    const result = await run(byName.get("studiorpc_game_input_inject"), { events: walkForward });

    expect(calls.map((call) => call.method)).toEqual(["game.pie.status", "game.input.inject"]);
    expect(calls[1].params).toMatchObject({ pieSessionId: "pie-1", clientId: "client-1", events: walkForward });
    expect(result.metadata).toMatchObject({ clientId: "client-1", eventCount: 3, status: "completed" });
  });

  test("inject waits out the batch instead of using the default RPC timeout", async () => {
    const { calls, byName } = toolsFor((call) => (call.method === "game.pie.status" ? runningStatus() : {}));

    await run(byName.get("studiorpc_game_input_inject"), { events: walkForward });

    expect(calls[1].timeoutMs).toBeGreaterThan(800);
  });

  test("inject rejects a batch that leaves a key held, before touching Studio", async () => {
    const { calls, byName } = toolsFor((call) => (call.method === "game.pie.status" ? runningStatus() : {}));

    await expect(
      run(byName.get("studiorpc_game_input_inject"), { events: [{ type: "key", key: "W", action: "down" }] }),
    ).rejects.toThrow(/heldInputMustBeReleasedInBatch/);
    expect(calls).toHaveLength(0);
  });

  test("inject rejects a release of a key that was never pressed", async () => {
    const { byName } = toolsFor(() => runningStatus());

    await expect(
      run(byName.get("studiorpc_game_input_inject"), {
        events: [
          { type: "key", key: "W", action: "up" },
          { type: "key", key: "W", action: "down" },
          { type: "key", key: "W", action: "up" },
        ],
      }),
    ).rejects.toThrow(/never pressed/);
  });

  test("inject rejects waits summing past the 10s batch limit", async () => {
    const { byName } = toolsFor(() => runningStatus());

    await expect(
      run(byName.get("studiorpc_game_input_inject"), {
        events: [
          { type: "key", key: "W", action: "down" },
          { type: "wait", durationMs: 6000 },
          { type: "wait", durationMs: 5000 },
          { type: "key", key: "W", action: "up" },
        ],
      }),
    ).rejects.toThrow(/totalDurationExceeded/);
  });

  test("inject points at game.play when no play test is running", async () => {
    const { calls, byName } = toolsFor(() =>
      runningStatus({ running: false, state: "stopped", pieSessionId: undefined }),
    );

    await expect(run(byName.get("studiorpc_game_input_inject"), { events: walkForward })).rejects.toThrow(
      /studiorpc_game_play/,
    );
    expect(calls.map((call) => call.method)).toEqual(["game.pie.status"]);
  });

  test("inject refuses a pieSessionId that no longer matches the live session", async () => {
    const { byName } = toolsFor(() => runningStatus());

    await expect(
      run(byName.get("studiorpc_game_input_inject"), { events: walkForward, pieSessionId: "pie-0" }),
    ).rejects.toThrow(/stalePieSession/);
  });

  test("inject refuses a client that Studio reports as not injectable", async () => {
    const { byName } = toolsFor(() => runningStatus());

    await expect(
      run(byName.get("studiorpc_game_input_inject"), { events: walkForward, clientId: "client-0" }),
    ).rejects.toThrow(/not injectable/);
  });

  test("move_to polls until the move reaches a terminal status", async () => {
    const statuses = ["pendingStart", "running", "reached"];
    let polls = 0;
    const { calls, byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-1", status: "pendingStart" };
      // Answered explicitly so the position reads either side of the move do not
      // draw from the poll sequence this test is counting.
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 0, Y: 0, Z: 0 } } } };
      }
      return { requestId: "req-1", status: statuses[Math.min(polls++, statuses.length - 1)], clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), { position: { x: 100, y: 200, z: 300 } });

    expect(calls.filter((call) => call.method === "game.character.moveStatus")).toHaveLength(3);
    expect(result.metadata).toMatchObject({ requestId: "req-1", status: "reached" });
  });

  test("move_to checks Studio's reached against where the character actually stopped", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-9", status: "pendingStart" };
      if (call.method === "game.character.read") {
        // Barely moved: a level with no navigation data still reports success.
        return { character: { CFrame: { Position: { X: 10, Y: 0, Z: 5 } } } };
      }
      return { requestId: "req-9", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      position: { x: 1000, y: 0, z: 5 },
    });

    expect(result.output).toContain("distanceToTarget");
    expect(result.output).toContain("no navigation data");
  });

  test("move_to stays quiet when the character really arrived", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-10", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 1000, Y: 0, Z: 5 } } } };
      }
      return { requestId: "req-10", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      position: { x: 1000, y: 0, z: 5 },
    });

    expect(result.output).not.toContain("no navigation data");
    expect(result.output).toContain('"distanceToTarget": 0');
  });

  test("move_to judges arrival against the tolerance the caller asked for", async () => {
    // Stopping 80 units away is arrival when travelling and a miss when the point
    // was to walk into something 40 units across.
    const stoppedShort = (call: { method: string }) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-11", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 920, Y: 0, Z: 5 } } } };
      }
      return { requestId: "req-11", status: "reached", clientId: "client-1" };
    };

    const lenient = await run(toolsFor(stoppedShort).byName.get("studiorpc_game_character_move_to"), {
      position: { x: 1000, y: 0, z: 5 },
    });
    expect(lenient.output).toContain('"arrivalTolerance": 150');
    expect(lenient.output).not.toContain("warning");

    const strict = await run(toolsFor(stoppedShort).byName.get("studiorpc_game_character_move_to"), {
      position: { x: 1000, y: 0, z: 5 },
      arrivalTolerance: 40,
    });
    expect(strict.output).toContain('"arrivalTolerance": 40');
    // Short of a tight tolerance is normal travel, not the level lacking navigation.
    expect(strict.output).toContain("treat whatever you were testing at that spot as unproven");
    expect(strict.output).not.toContain("no navigation data");
  });

  test("move_to separates a move that was unnecessary from one that went nowhere", async () => {
    // Same start and end, but one is already at the target and the other is stuck.
    const parked = (position: { X: number; Z: number }) => (call: { method: string }) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-13", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: position.X, Y: 0, Z: position.Z } } } };
      }
      return { requestId: "req-13", status: "reached", clientId: "client-1" };
    };

    const alreadyThere = await run(toolsFor(parked({ X: 1000, Z: 5 })).byName.get("studiorpc_game_character_move_to"), {
      position: { x: 1000, y: 0, z: 5 },
    });
    expect(alreadyThere.output).toContain('"moved": false');
    expect(alreadyThere.output).toContain('"blocked": false');

    const stuck = await run(toolsFor(parked({ X: 0, Z: 0 })).byName.get("studiorpc_game_character_move_to"), {
      position: { x: 5000, y: 0, z: 0 },
    });
    expect(stuck.output).toContain('"moved": false');
    expect(stuck.output).toContain('"blocked": true');
  });

  test("move_to does not call a character blocked when navigation is simply satisfied", async () => {
    // 30 units out with a tolerance of 10: not arrived, did not move, not blocked —
    // navigation stops itself around here and will not re-approach from inside it.
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-14", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 970, Y: 0, Z: 5 } } } };
      }
      return { requestId: "req-14", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      position: { x: 1000, y: 0, z: 5 },
      arrivalTolerance: 10,
    });

    expect(result.output).toContain('"blocked": false');
    expect(result.output).toContain("will not make it walk");
  });

  test("move_to reports a character that walked into a wall as blocked", async () => {
    // Stopped 44 units short of a target behind a solid gate. That is inside the
    // distance navigation normally stops at, so only the timedOut status tells the
    // difference between a wall and navigation being content.
    let read = 0;
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-16", status: "pendingStart" };
      if (call.method === "game.character.read") {
        // Started at the origin, walked most of the way, stopped at the gate.
        const x = read++ === 0 ? 0 : 956;
        return { character: { CFrame: { Position: { X: x, Y: 0, Z: 0 } } } };
      }
      return { requestId: "req-16", status: "timedOut", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      position: { x: 1000, y: 0, z: 0 },
      arrivalTolerance: 20,
    });

    expect(result.output).toContain('"blocked": true');
    expect(result.output).toContain('"moved": true');
  });

  test("passThrough aims past the point so the walk crosses it", async () => {
    const { calls, byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-17", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 0, Y: 0, Z: 0 } } } };
      }
      return { requestId: "req-17", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      position: { x: 100, y: 60, z: 0 },
      passThrough: true,
    });

    // Approaching along +x from the origin, so the aim point is 200 further along it.
    const sent = calls.find((call) => call.method === "game.character.moveTo");
    expect((sent?.params as { position: { x: number; z: number } }).position).toMatchObject({ x: 300, z: 0 });
    expect(result.output).toContain('"aimedAt"');
    expect(result.output).toContain('"passedWithin"');
    // Distance is still reported against the coin, not the point past it: the
    // character sits at the origin and the coin is 100 out and 60 up, so 117.
    expect(result.output).toContain('"distanceToTarget": 117');
  });

  test("passThrough counts crossing the target, not stopping near it", async () => {
    // Walks from the origin to x=520, straight over a coin at x=350. It ends 170
    // past the coin, which is exactly the point, so it must not read as blocked.
    let read = 0;
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-19", status: "pendingStart" };
      if (call.method === "game.character.read") {
        const x = read++ === 0 ? 0 : 520;
        return { character: { CFrame: { Position: { X: x, Y: 60, Z: 250 } } } };
      }
      return { requestId: "req-19", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      position: { x: 350, y: 60, z: 250 },
      passThrough: true,
      arrivalTolerance: 45,
    });

    expect(result.output).toContain('"passedWithin": 0');
    expect(result.output).toContain('"crossed": true');
    expect(result.output).toContain('"blocked": false');
  });

  test("move_to walks to a named instance and sizes the tolerance to it", async () => {
    const { calls, byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.instance.read") {
        return { instance: { CFrame: { Position: { X: 350, Y: 60, Z: 250 } }, Size: { X: 90, Y: 90, Z: 90 } } };
      }
      if (call.method === "game.character.moveTo") return { requestId: "req-20", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 350, Y: 60, Z: 250 } } } };
      }
      return { requestId: "req-20", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), { targetName: "Coin1" });

    const sent = calls.find((call) => call.method === "game.character.moveTo");
    expect((sent?.params as { position: unknown }).position).toMatchObject({ x: 350, y: 60, z: 250 });
    // 90 across, so 45 from the centre — not the 150 default.
    expect(result.output).toContain('"arrivalTolerance": 45');
    expect(result.output).toContain('"targetPosition"');
  });

  test("move_to says so when the named instance is not in the world", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.instance.read") return {};
      return { requestId: "req-21", status: "reached", clientId: "client-1" };
    });

    await expect(run(byName.get("studiorpc_game_character_move_to"), { targetName: "Nope" })).rejects.toThrow(
      /No instance named "Nope"/,
    );
  });

  test("move_to gives up on a character that has stopped moving", async () => {
    // Navigation keeps saying running; the position never changes. Waiting out the
    // whole budget would only confirm what two samples already show.
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-18", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 500, Y: 0, Z: 0 } } } };
      }
      return { requestId: "req-18", status: "running", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      position: { x: 5000, y: 0, z: 0 },
      timeoutMs: 60_000,
    });

    expect(result.output).toContain('"blocked": true');
    expect(result.output).toContain("stuck rather than slow");
    // It must not have burned the full minute to say so.
    const waited = Number(/"waitedMs": (\d+)/.exec(result.output)?.[1] ?? 0);
    expect(waited).toBeLessThan(30_000);
  });

  test("move_to withholds a verdict while the move is still running", async () => {
    // A character partway through a journey has not moved much and is not near the
    // target; saying `blocked` there states an outcome the move has not reached.
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-15", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 1, Y: 0, Z: 0 } } } };
      }
      return { requestId: "req-15", status: "running", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      position: { x: 5000, y: 0, z: 0 },
      timeoutMs: 1_000,
    });

    expect(result.output).not.toContain('"blocked"');
    expect(result.output).not.toContain('"endedAt"');
    expect(result.output).toContain('"at"');
    expect(result.output).toContain("no blocked verdict yet");
  });

  test("move_to still calls out a move that went nowhere", async () => {
    const wentNowhere = (call: { method: string }) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-12", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 0, Y: 0, Z: 0 } } } };
      }
      return { requestId: "req-12", status: "reached", clientId: "client-1" };
    };

    const result = await run(toolsFor(wentNowhere).byName.get("studiorpc_game_character_move_to"), {
      position: { x: 5000, y: 0, z: 0 },
    });

    expect(result.output).toContain("no navigation data");
  });

  test("move_to returns immediately when wait is false", async () => {
    const { calls, byName } = toolsFor((call) =>
      call.method === "game.pie.status" ? runningStatus() : { requestId: "req-2", status: "pendingStart" },
    );

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      position: { x: 0, y: 0, z: 0 },
      wait: false,
    });

    expect(calls.some((call) => call.method === "game.character.moveStatus")).toBe(false);
    expect(result.metadata).toMatchObject({ requestId: "req-2", status: "pendingStart" });
  });

  test("move_to reports the still-running move when its wait budget runs out", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-3", status: "pendingStart" };
      return { requestId: "req-3", status: "running", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      position: { x: 1, y: 2, z: 3 },
      timeoutMs: 1000,
    });

    expect(result.metadata).toMatchObject({ status: "running" });
    expect(result.output).toContain("studiorpc_game_character_move_status");
  });

  test("move_status marks non-terminal statuses as not done", async () => {
    const { byName } = toolsFor((call) =>
      call.method === "game.pie.status"
        ? runningStatus()
        : { requestId: "req-4", status: "running", clientId: "client-1" },
    );

    const running = await run(byName.get("studiorpc_game_character_move_status"), { requestId: "req-4" });
    expect(running.metadata).toMatchObject({ status: "running", done: false });
  });

  test("move_status reads the outcome even when no client accepts input any more", async () => {
    const noInjectable = runningStatus({
      clients: [
        {
          clientId: "client-1",
          clientIndex: 1,
          pieInstance: 1,
          processId: 1,
          netMode: "Client",
          ready: false,
          injectable: false,
        },
      ],
    });
    const { calls, byName } = toolsFor((call) =>
      call.method === "game.pie.status"
        ? noInjectable
        : { requestId: "req-5", status: "reached", clientId: "client-1" },
    );

    const result = await run(byName.get("studiorpc_game_character_move_status"), { requestId: "req-5" });

    expect(calls[1].params).toMatchObject({ pieSessionId: "pie-1", requestId: "req-5" });
    expect(result.metadata).toMatchObject({ status: "reached", done: true });
  });

  test("inject expands a press into the down/wait/up Studio understands", async () => {
    const { calls, byName } = toolsFor((call) => (call.method === "game.pie.status" ? runningStatus() : {}));

    await run(byName.get("studiorpc_game_input_inject"), {
      events: [{ type: "key", key: "W", action: "press", durationMs: 500 }],
    });

    expect(calls[1].params?.events).toEqual([
      { type: "key", key: "W", action: "down" },
      { type: "wait", durationMs: 500 },
      { type: "key", key: "W", action: "up" },
    ]);
    expect(calls[1].timeoutMs).toBeGreaterThan(500);
  });

  test("inject makes a press without a duration a bare down/up tap", async () => {
    const { calls, byName } = toolsFor((call) => (call.method === "game.pie.status" ? runningStatus() : {}));

    await run(byName.get("studiorpc_game_input_inject"), {
      events: [{ type: "pointerButton", button: "left", action: "press" }],
    });

    expect(calls[1].params?.events).toEqual([
      { type: "pointerButton", button: "left", action: "down" },
      { type: "pointerButton", button: "left", action: "up" },
    ]);
  });

  test("inject counts expanded events against Studio's batch limit", async () => {
    const { calls, byName } = toolsFor(() => runningStatus());
    const events = Array.from({ length: 30 }, () => ({
      type: "key",
      key: "W",
      action: "press",
      durationMs: 10,
    }));

    await expect(run(byName.get("studiorpc_game_input_inject"), { events })).rejects.toThrow(/expands to 90 events/);
    expect(calls).toHaveLength(0);
  });

  test("inject accepts scroll and textInput events", async () => {
    const { calls, byName } = toolsFor((call) => (call.method === "game.pie.status" ? runningStatus() : {}));
    const events = [
      { type: "scroll", delta: -3 },
      { type: "textInput", text: "hello" },
    ];

    await run(byName.get("studiorpc_game_input_inject"), { events });

    expect(calls[1].params?.events).toEqual(events);
  });

  test("pie_status reports clients without needing a running session", async () => {
    const { byName } = toolsFor(() => runningStatus({ running: false, state: "stopped" }));

    const result = await run(byName.get("studiorpc_game_pie_status"), {});

    expect(result.metadata).toMatchObject({ running: false, clients: 2 });
    expect(result.render?.blocks?.some((block) => block.type === "table")).toBe(true);
  });
});

async function providerTools(result: unknown) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const provider = createStudioRpcToolProvider({
    callRpc: async (method, params) => {
      calls.push({ method, params });
      return result;
    },
  });
  const tools = await provider.createTools({ cwd: "/tmp/project", host: { approve: async () => "once" } });
  return { calls, tools };
}

describe("game.screenshot", () => {
  test("forwards includeGui so the shot can show the UI that gets clicked", async () => {
    const { calls, tools } = await providerTools({ path: "C:/shot.png" });
    const screenshot = tools.find((tool) => tool.name === "studiorpc_game_screenshot");

    expect(() => screenshot?.parameters.parse({ includeGui: true })).not.toThrow();
    await screenshot?.execute({ includeGui: true } as never, ctx as never);

    expect(calls.find((call) => call.method === "game.screenshot")?.params).toMatchObject({ includeGui: true });
  });

  test("forwards a one-shot camera aim", async () => {
    const { calls, tools } = await providerTools({ path: "C:/shot.png" });
    const screenshot = tools.find((tool) => tool.name === "studiorpc_game_screenshot");
    const aim = { cameraPosition: { x: 0, y: 0, z: 500 }, lookAt: { x: 0, y: 0, z: 0 } };

    await screenshot?.execute(aim as never, ctx as never);

    expect(calls.find((call) => call.method === "game.screenshot")?.params).toMatchObject(aim);
  });

  test("reports the size Studio captured rather than the size that was asked for", async () => {
    const { tools } = await providerTools({
      path: "C:/shot.png",
      image: { width: 1920, height: 1080 },
      source: "pieClient",
    });
    const screenshot = tools.find((tool) => tool.name === "studiorpc_game_screenshot");

    const result = await screenshot?.execute({} as never, ctx as never);
    const items = result?.render?.blocks?.flatMap((block) => ("items" in block ? block.items : []));

    expect(items).toContainEqual({ key: "size", value: "1920×1080" });
    expect(items).toContainEqual({ key: "source", value: "pieClient" });
  });
});

describe("camera and UI reading tools", () => {
  test("are registered on the Studio RPC provider", async () => {
    const { tools } = await providerTools({});
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("studiorpc_viewport_camera_read");
    expect(names).toContain("studiorpc_game_ui_browse");
  });

  test("ui_browse summarizes what is on screen", async () => {
    const { tools } = await providerTools({
      viewport: { width: 1920, height: 1080 },
      elements: [
        { path: "PlayerGui.MainMenu", class: "ScreenGui", rect: { x: 0, y: 0, w: 1, h: 1 }, onScreen: true },
        {
          path: "PlayerGui.MainMenu.StartButton",
          class: "TextButton",
          text: "Start",
          rect: { x: 0.42, y: 0.61, w: 0.16, h: 0.07 },
          onScreen: true,
        },
        {
          path: "PlayerGui.MainMenu.OffScreenButton",
          class: "TextButton",
          text: "Nope",
          rect: { x: 1.2, y: 0.4, w: 0.2, h: 0.08 },
          visible: true,
          onScreen: false,
        },
      ],
    });
    const browse = tools.find((tool) => tool.name === "studiorpc_game_ui_browse");

    const result = await browse?.execute({} as never, ctx as never);

    expect(result?.render?.outputSummary).toBe("3 UI elements");
    // A button that is off screen is not something the agent can click, so it is not offered.
    const items = result?.render?.blocks?.flatMap((block) => ("items" in block ? block.items : []));
    expect(items).toContainEqual({ key: "buttons", value: "Start" });
  });

  test("camera_read names what the screen center is on", async () => {
    const { tools } = await providerTools({
      source: "pieClient",
      viewport: { width: 1920, height: 1080 },
      camera: {
        CFrame: { Position: { x: 0, y: 0, z: 100 }, Orientation: { x: 0, y: 0, z: 0 } },
        focusDistance: 1250.4,
        centerHit: { position: { x: 0, y: 1250, z: 100 }, instanceName: "Baseplate" },
      },
    });
    const camera = tools.find((tool) => tool.name === "studiorpc_viewport_camera_read");

    const result = await camera?.execute({} as never, ctx as never);
    const items = result?.render?.blocks?.flatMap((block) => ("items" in block ? block.items : []));

    expect(result?.render?.outputSummary).toBe("looking at Baseplate");
    expect(items).toContainEqual({ key: "focusDistance", value: "1250 units" });
    expect(items).toContainEqual({ key: "source", value: "pieClient" });
  });
});
