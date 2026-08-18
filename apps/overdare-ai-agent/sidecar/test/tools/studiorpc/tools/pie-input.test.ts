// @summary Tests the play-test input tools: target resolution, batch rules, and moveTo waiting.

import { describe, expect, test } from "bun:test";
import type { Tool } from "@diligent/core/tool-contract";
import { createStudioRpcToolProvider } from "../../../../src/tools/studiorpc";
import { StudioRpcError } from "../../../../src/tools/studiorpc/rpc";
import {
  createPieInputTools,
  moveStallWindowMs,
  normalizeWaitedMoveStatus,
} from "../../../../src/tools/studiorpc/tools/pie-input";

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
  test("normalizes waited move status to the measured outcome", () => {
    expect(normalizeWaitedMoveStatus("arrived", "running")).toBe("reached");
    expect(normalizeWaitedMoveStatus("blocked", "running")).toBe("blocked");
    expect(normalizeWaitedMoveStatus("stoppedShort", "reached")).toBe("stoppedShort");
    expect(normalizeWaitedMoveStatus("stillMoving", "running")).toBe("running");
  });

  test("expresses the stall window in game time when the world is slowed", () => {
    expect(moveStallWindowMs(1)).toBe(3_000);
    expect(moveStallWindowMs(10)).toBe(3_000);
    expect(moveStallWindowMs(0.2)).toBe(15_000);
    expect(moveStallWindowMs(0.05)).toBe(60_000);
    expect(moveStallWindowMs(undefined)).toBe(3_000);
  });

  test("are registered on the Studio RPC provider", async () => {
    const provider = createStudioRpcToolProvider({ callRpc: async () => ({}) });
    const names = (await provider.createTools({ cwd: "/tmp/project" })).map((tool) => tool.name);

    expect(names).toContain("studiorpc_game_pie_status");
    expect(names).toContain("studiorpc_game_input_inject");
    expect(names).toContain("studiorpc_game_character_move_to");
    // Cut: 7 calls in 60 runs, the newest 35 runs ago, and since `wait` left move_to there is
    // no unfinished move to poll that a larger timeoutMs would not have waited out.
    expect(names).not.toContain("studiorpc_game_character_move_status");
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

  test("inject accepts a pointer event written with flat x and y", async () => {
    // `position` is nested and writing it flat is the natural mistake; the validator
    // answered it by naming a field the caller believed they had supplied.
    const { calls, byName } = toolsFor((call) =>
      call.method === "game.pie.status" ? runningStatus() : { sequenceId: "seq-2", status: "completed" },
    );

    await run(byName.get("studiorpc_game_input_inject"), {
      events: [
        { type: "pointerMove", x: 0.4, y: 0.9 },
        { type: "pointerButton", button: "left", action: "press", durationMs: 100 },
      ],
    });

    const sent = calls.find((call) => call.method === "game.input.inject");
    const events = (sent?.params as { events: Array<Record<string, unknown>> }).events;
    expect(events[0]).toMatchObject({ type: "pointerMove", position: { x: 0.4, y: 0.9 } });
    expect(events[0].x).toBeUndefined();
  });

  test("a click written as a positioned press moves the pointer there first", async () => {
    // Measured in playtest2 on 2026-08-16: a pointerButton carrying a position had it
    // dropped by schema parsing, so the press landed on whatever sat under the pointer's
    // last resting place — the viewport centre. Studio answered `status: completed` with
    // `pointerUpSameLeaf: true` and `pointerLeafType: SObjectWidget`, which reads as a
    // clean click, and the button never fired. Sending the same point as a pointerMove
    // first resolved to SButton and pressed the button, 3 tries out of 3 either way.
    const { calls, byName } = toolsFor((call) =>
      call.method === "game.pie.status" ? runningStatus() : { sequenceId: "seq-pos", status: "completed" },
    );

    await run(byName.get("studiorpc_game_input_inject"), {
      events: [{ type: "pointerButton", button: "left", action: "press", position: { x: 0.405, y: 0.875 } }],
    });

    const sent = calls.find((call) => call.method === "game.input.inject");
    const events = (sent?.params as { events: Array<Record<string, unknown>> }).events;
    expect(events[0]).toMatchObject({ type: "pointerMove", position: { x: 0.405, y: 0.875 } });
    expect(events[1]).toMatchObject({ type: "pointerButton", action: "down" });
    // The position must not ride along on the button events; Studio ignores it there.
    expect(events[1].position).toBeUndefined();
    expect(events[events.length - 1]).toMatchObject({ type: "pointerButton", action: "up" });
  });

  test("a positioned click written with flat x and y moves there too", async () => {
    const { calls, byName } = toolsFor((call) =>
      call.method === "game.pie.status" ? runningStatus() : { sequenceId: "seq-flat", status: "completed" },
    );

    await run(byName.get("studiorpc_game_input_inject"), {
      events: [{ type: "pointerButton", button: "left", action: "press", x: 0.4, y: 0.9 }],
    });

    const sent = calls.find((call) => call.method === "game.input.inject");
    const events = (sent?.params as { events: Array<Record<string, unknown>> }).events;
    expect(events[0]).toMatchObject({ type: "pointerMove", position: { x: 0.4, y: 0.9 } });
  });

  test("a press with no position leaves the pointer where it is", async () => {
    const { calls, byName } = toolsFor((call) =>
      call.method === "game.pie.status" ? runningStatus() : { sequenceId: "seq-nopos", status: "completed" },
    );

    await run(byName.get("studiorpc_game_input_inject"), {
      events: [
        { type: "pointerMove", position: { x: 0.4, y: 0.9 } },
        { type: "pointerButton", button: "left", action: "press", durationMs: 100 },
      ],
    });

    const sent = calls.find((call) => call.method === "game.input.inject");
    const events = (sent?.params as { events: Array<Record<string, unknown>> }).events;
    expect(events.filter((event) => event.type === "pointerMove")).toHaveLength(1);
  });

  test("inject preserves Studio pointer-route diagnostics", async () => {
    const { byName } = toolsFor((call) =>
      call.method === "game.pie.status"
        ? runningStatus()
        : {
            sequenceId: "seq-pointer",
            status: "completed",
            appliedEventCount: 4,
            pointerRouteCount: 3,
            pointerHandledCount: 2,
            pointerRouteRepaired: true,
            pointerCaptureRepaired: true,
            pointerLeafType: "SMigalooUIButton",
          },
    );

    const result = await run(byName.get("studiorpc_game_input_inject"), {
      events: [
        { type: "pointerMove", position: { x: 0.4, y: 0.9 } },
        { type: "pointerButton", button: "left", action: "press", durationMs: 100 },
      ],
    });

    expect(result.output).toContain('"pointerRouteCount": 3');
    expect(result.output).toContain('"pointerHandledCount": 2');
    expect(result.output).toContain('"pointerRouteRepaired": true');
    expect(result.output).toContain('"pointerCaptureRepaired": true');
    expect(result.output).toContain('"pointerLeafType": "SMigalooUIButton"');
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

  // Run 44 authored two events and was told events[4] was at fault. The limit is
  // checked on the expanded batch, so the index has to be mapped back.
  test("inject reports the batch limit against the event the caller wrote", async () => {
    const { byName } = toolsFor(() => runningStatus());

    await expect(
      run(byName.get("studiorpc_game_input_inject"), {
        events: [
          { type: "key", key: "W", action: "press", durationMs: 60 },
          { type: "wait", durationMs: 10000 },
        ],
      }),
    ).rejects.toThrow(/events\[1\]: the batch spends 10060ms/);
  });

  test("inject says press holds count toward the batch limit", async () => {
    const { byName } = toolsFor(() => runningStatus());

    await expect(
      run(byName.get("studiorpc_game_input_inject"), {
        events: [
          { type: "key", key: "W", action: "press", durationMs: 60 },
          { type: "wait", durationMs: 10000 },
        ],
      }),
    ).rejects.toThrow(/a press is a hold and spends its time the same way/);
  });

  test("inject sends a look through and reports how far the view turned", async () => {
    const { calls, byName } = toolsFor((call) =>
      call.method === "game.pie.status"
        ? runningStatus()
        : {
            sequenceId: "seq-3",
            status: "completed",
            appliedEventCount: 1,
            looks: [
              {
                status: "reached",
                requested: { yawDegrees: 90, pitchDegrees: 0 },
                turned: { yawDegrees: 89.6, pitchDegrees: 0.1 },
                facing: { yaw: 89.6, pitch: 0.1 },
              },
            ],
          },
    );

    const result = await run(byName.get("studiorpc_game_input_inject"), {
      events: [{ type: "look", yawDegrees: 90 }],
    });

    const sent = calls.find((call) => call.method === "game.input.inject");
    expect((sent?.params as { events: Array<Record<string, unknown>> }).events[0]).toMatchObject({
      type: "look",
      yawDegrees: 90,
    });
    // Converging spends real time, so the RPC waits out the look budget like a wait.
    expect(sent?.timeoutMs).toBeGreaterThan(2000);
    expect(result.output).toContain('"reached"');
    expect(result.output).toContain("89.6");
  });

  test("inject rejects a look that asks for no rotation", async () => {
    const { calls, byName } = toolsFor(() => runningStatus());

    await expect(run(byName.get("studiorpc_game_input_inject"), { events: [{ type: "look" }] })).rejects.toThrow(
      /lookOutOfRange/,
    );
    expect(calls).toHaveLength(0);
  });

  test("inject counts look budgets toward the 10s batch limit", async () => {
    const { byName } = toolsFor(() => runningStatus());

    await expect(
      run(byName.get("studiorpc_game_input_inject"), {
        events: [
          { type: "look", yawDegrees: 90, timeoutMs: 5000 },
          { type: "look", yawDegrees: 90, timeoutMs: 5000 },
          { type: "wait", durationMs: 1000 },
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

    const result = await run(byName.get("studiorpc_game_character_move_to"), { target: { x: 100, y: 200, z: 300 } });

    expect(calls.filter((call) => call.method === "game.character.moveStatus")).toHaveLength(3);
    // Polling reached a terminal raw status, but the measured position is still far
    // away, so the wrapper's stable status is blocked and preserves Studio's claim.
    expect(result.metadata).toMatchObject({ requestId: "req-1", status: "blocked", rawNavStatus: "reached" });
  });

  // A move can be aimed at any injectable client, and the reading that checks it used to be
  // pinned to the main one. Measured in a real two-player session: the move walked the second
  // player to within 20 units of the target and the reply, describing the first, said
  // arrived: false, distanceToTarget: 1603, and blamed missing navigation data. Worse than
  // being unable to look — a confident wrong answer.
  test("a move that names a client measures that client, not the main one", async () => {
    const twoPlayers = runningStatus({
      clients: [
        {
          clientId: "client-1",
          clientIndex: 0,
          pieInstance: 1,
          processId: 1,
          netMode: "Client",
          ready: true,
          injectable: true,
        },
        {
          clientId: "client-2",
          clientIndex: 1,
          pieInstance: 2,
          processId: 1,
          netMode: "Client",
          ready: true,
          injectable: true,
        },
      ],
    });
    const { calls, byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return twoPlayers;
      if (call.method === "game.character.moveTo") return { requestId: "req-2p", status: "pendingStart" };
      if (call.method === "game.character.read") {
        // The main client never left the spawn; the one being driven walked to the target.
        const position = call.params?.clientId === "client-2" ? { X: 1000, Y: 0, Z: 0 } : { X: 0, Y: 0, Z: 0 };
        return { character: { CFrame: { Position: position } } };
      }
      return { requestId: "req-2p", status: "reached", clientId: "client-2" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 1000, y: 0, z: 0 },
      clientId: "client-2",
    });

    const reads = calls.filter((call) => call.method === "game.character.read");
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.params).toMatchObject({ clientId: "client-2", pieSessionId: "pie-1" });
    }
    // Reading the main client instead would have called this a blocked move that went nowhere.
    expect(result.metadata).toMatchObject({ status: "reached", clientId: "client-2" });
    expect(JSON.parse(result.output)).toMatchObject({ arrived: true, outcome: "arrived" });
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
      target: { x: 1000, y: 0, z: 5 },
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
      target: { x: 1000, y: 0, z: 5 },
    });

    expect(result.output).not.toContain("no navigation data");
    expect(result.output).toContain('"distanceToTarget": 0');
    expect(result.output).toContain('"navStatus": "reached"');
    expect(result.output).not.toContain('"rawNavStatus"');
  });

  // Glasshouse, measured 2026-08-17: asking twice for a 560-wide bed answered
  // `outcome: blocked`, `rawNavStatus: reached`, `movedDistance: 0`, `waitedMs: 339`, and a
  // warning reading "stopped 150 units from the target, which is outside the 150 units that
  // count as arrival" — a sentence that refutes itself, because the real distance was 150.1 and
  // both numbers rounded to 150. Run 76 read the reply and concluded `waitedMs` was unusable, which
  // is the wrong lesson: 339 ms is honestly how long a move that never started takes. Nothing
  // in the reply said it never started.
  test("move_to says when a move never set off, and does not round its numbers into a contradiction", async () => {
    const parked = (call: { method: string }) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.instance.read") {
        return { instance: { CFrame: { Position: { X: 1000, Y: 0, Z: 5 } }, Size: { X: 10, Y: 10, Z: 10 } } };
      }
      if (call.method === "game.character.moveTo") return { requestId: "req-80", status: "pendingStart" };
      if (call.method === "game.character.read") {
        // 65.1 from the centre of a 10-wide part is 60.1 to its surface: just outside the
        // 60-unit touch margin, which is the only place the two numbers still round together.
        return { character: { CFrame: { Position: { X: 934.9, Y: 0, Z: 5 } } } };
      }
      return { requestId: "req-80", status: "reached", clientId: "client-1" };
    };

    const result = await run(toolsFor(parked).byName.get("studiorpc_game_character_move_to"), { target: "Bed" });

    // 60.1 against a radius of 60 is a miss, and the sentence has to be able to say so.
    expect(result.output).not.toContain("stopped 60 units from the target, which is outside the 60 units");
    expect(result.output).toContain("60.1 units from the target");
    // The fact that was missing, and the misreading it caused.
    expect(result.output).toContain('"didNotSetOff": true');
    expect(result.output).toContain("never set off");
    expect(result.output).toContain("not a fast walk");
  });

  // The other way to not set off, found by the gate on playtest2 an hour after the first:
  // navigation still `running` while the character stands against a door. `movedDistance: 0`
  // is identical in both, and the advice is opposite — one is futile to retry, the other has
  // something in the way — so the fact is reported either way and the sentence is not.
  test("move_to distinguishes navigation declining to walk from something holding the character", async () => {
    const held = (call: { method: string }) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-81", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 800, Y: 0, Z: 5 } } } };
      }
      return { requestId: "req-81", status: "running", clientId: "client-1" };
    };

    const result = await run(toolsFor(held).byName.get("studiorpc_game_character_move_to"), {
      target: { x: 1000, y: 0, z: 5 },
    });

    expect(result.output).toContain('"didNotSetOff": true');
    expect(result.output).toContain("navigation never reported reaching anything either");
    // The advice for the other case would be actively wrong here.
    expect(result.output).not.toContain("asking for the same point again will not make it walk");
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
      target: { x: 1000, y: 0, z: 5 },
    });
    expect(alreadyThere.output).toContain('"moved": false');
    expect(alreadyThere.output).toContain('"blocked": false');

    const stuck = await run(toolsFor(parked({ X: 0, Z: 0 })).byName.get("studiorpc_game_character_move_to"), {
      target: { x: 5000, y: 0, z: 0 },
    });
    expect(stuck.output).toContain('"moved": false');
    expect(stuck.output).toContain('"blocked": true');
  });
  // `navSatisfied` used to excuse a stop inside the distance navigation settles at. Removing
  // the caller-set tolerance made it unreachable — 50 units is inside every radius that now
  // counts as arrival — so the branch went. This holds the floor: if a smaller radius is ever
  // introduced, the excuse has to come back with it rather than be rediscovered as a bug.
  test("every distance navigation settles at is already an arrival", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.instance.read") {
        return { instance: { CFrame: { Position: { X: 1000, Y: 0, Z: 5 } }, Size: { X: 10, Y: 10, Z: 10 } } };
      }
      if (call.method === "game.character.moveTo") return { requestId: "req-14", status: "pendingStart" };
      if (call.method === "game.character.read") {
        // 50 units from the centre of a 10-wide part: 45 to its surface, the furthest
        // navigation settles at, and inside the 60-unit touch margin.
        return { character: { CFrame: { Position: { X: 950, Y: 0, Z: 5 } } } };
      }
      return { requestId: "req-14", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), { target: "Terminal" });

    expect(result.output).toContain('"arrived": true');
    expect(result.output).toContain('"blocked": false');
  });

  test("move_to reports a character that walked into a wall as blocked", async () => {
    // Stopped 200 units short of a target behind a solid gate, having walked most of the
    // way. Only the timedOut status tells a wall from navigation being content.
    let read = 0;
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-16", status: "pendingStart" };
      if (call.method === "game.character.read") {
        // Started at the origin, walked most of the way, stopped at the gate.
        const x = read++ === 0 ? 0 : 800;
        return { character: { CFrame: { Position: { X: x, Y: 0, Z: 0 } } } };
      }
      return { requestId: "req-16", status: "timedOut", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 1000, y: 0, z: 0 },
    });

    expect(result.output).toContain('"blocked": true');
    expect(result.output).toContain('"moved": true');
  });

  // Run 44 landed on a plinth and was told `blocked, distanceToTarget: 84`. That 84
  // is the capsule half-height between the character's origin and its feet, so the
  // tolerance could never be met by standing on the thing.
  test("move_to counts standing on the target as arriving at it", async () => {
    let read = 0;
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-30", status: "pendingStart" };
      if (call.method === "game.instance.read") {
        return { instance: { CFrame: { Position: { X: 150, Y: 20, Z: 0 } }, Size: { X: 80, Y: 40, Z: 80 } } };
      }
      if (call.method === "game.character.read") {
        // Started away from it, finished on its top face — origin 84 above the surface.
        const on = read++ > 0;
        return {
          character: {
            CFrame: { Position: { X: on ? 150 : 0, Y: on ? 124 : 84, Z: 0 } },
            standingOn: on ? { instanceName: "PlinthMid", distance: 0 } : { instanceName: "Lane", distance: 0 },
          },
        };
      }
      return { requestId: "req-30", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), { target: "PlinthMid" });

    expect(result.output).toContain('"outcome": "arrived"');
    expect(result.output).toContain('"standingOnTarget": "PlinthMid"');
    expect(result.output).not.toContain('"blocked": true');
    // The distance is still reported honestly; the note is what reconciles the two.
    expect(result.output).toContain('"distanceToTarget": 84');
    expect(result.output).toContain("capsule half-height");
    // Standing on its top face: 84 units away in three dimensions, 0 away in the flat measure a
    // game's own reach rule is written in. Both are true and only the second answers the rule —
    // which is why two runs were computing this one by hand from endedAt and the target's centre.
    expect(result.output).toContain('"horizontalDistanceToCentre": 0');
  });

  test("move_to still says blocked when standing on something that is not the target", async () => {
    let read = 0;
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-31", status: "pendingStart" };
      if (call.method === "game.instance.read") {
        return { instance: { CFrame: { Position: { X: 150, Y: 20, Z: 0 } }, Size: { X: 80, Y: 40, Z: 80 } } };
      }
      if (call.method === "game.character.read") {
        const x = read++ === 0 ? 0 : 20;
        return {
          character: {
            CFrame: { Position: { X: x, Y: 84, Z: 0 } },
            standingOn: { instanceName: "Lane", distance: 0 },
          },
        };
      }
      return { requestId: "req-31", status: "timedOut", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), { target: "PlinthMid" });

    expect(result.output).toContain('"outcome": "blocked"');
    expect(result.output).not.toContain('"standingOnTarget"');
  });

  // Run 47 crossed a gangway, fell in, was put back at the spawn, and navigation
  // re-walked the whole route — and was told `arrived`. It read that as the chute
  // being broken and spent several calls disproving a game defect that was not there.
  test("move_to says so when the character was moved rather than walked partway through", async () => {
    const walk = [
      { X: 0, Y: 84, Z: 0 },
      { X: 150, Y: 84, Z: 0 },
      { X: 300, Y: 84, Z: 0 },
      // Fell in and was returned to the spawn: no walk covers this in one poll.
      { X: -900, Y: 84, Z: 0 },
      { X: -900, Y: 84, Z: 0 },
    ];
    let read = 0;
    let polls = 0;
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-40", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: walk[Math.min(read++, walk.length - 1)] } } };
      }
      return { requestId: "req-40", status: polls++ < 3 ? "running" : "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 600, y: 84, z: 0 },
      passThrough: true,
    });

    expect(result.output).toContain('"respawnedMidMove": 1');
    expect(result.output).toContain("fell or died");
    // The jump is not a stretch of walk, so nothing may be measured along it: the line
    // from x=300 back to x=-900 passes straight through the target at x=600 only if you
    // pretend the character travelled it.
    expect(result.output).not.toContain('"crossed": true');
  });

  test("move_to reports the walked length when the route was longer than the line", async () => {
    // Rounds a corner: 600 units of walking between ends 424 apart.
    const walk = [
      { X: 0, Y: 84, Z: 0 },
      { X: 0, Y: 84, Z: 150 },
      { X: 0, Y: 84, Z: 300 },
      { X: 150, Y: 84, Z: 300 },
      { X: 300, Y: 84, Z: 300 },
    ];
    let read = 0;
    let polls = 0;
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-41", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: walk[Math.min(read++, walk.length - 1)] } } };
      }
      return { requestId: "req-41", status: polls++ < 3 ? "running" : "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 300, y: 84, z: 300 },
    });

    expect(result.output).toContain('"movedDistance": 424');
    expect(result.output).toContain('"walkedDistance": 600');
    expect(result.output).not.toContain('"respawnedMidMove"');
  });

  // Run 47 asked to walk to the parcel already in the character's hands and got a
  // targetPosition equal to its own position, movedDistance 0, and a note claiming
  // the walk had gone directly over it.
  test("move_to says a named target was already where the character stood", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-42", status: "pendingStart" };
      if (call.method === "game.instance.read") {
        return { instance: { CFrame: { Position: { X: 100, Y: 90, Z: 40 } }, Size: { X: 40, Y: 40, Z: 40 } } };
      }
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 100, Y: 84, Z: 40 } } } };
      }
      return { requestId: "req-42", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: "ParcelRed",
      passThrough: true,
    });

    expect(result.output).toContain('"alreadyAtTarget": "ParcelRed"');
    expect(result.output).toContain("moves with it");
    // No approach happened, so there is nothing to report about one.
    expect(result.output).not.toContain('"passedWithin"');
    expect(result.output).not.toContain("went directly over");
  });

  // Run 49 was walked off the roof by the pass-through overshoot and read
  // `arrived: true, crossed: true` beside an endedAt with y = -35.9.
  test("move_to says the move ended in mid-air rather than anywhere", async () => {
    let read = 0;
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-44", status: "pendingStart" };
      if (call.method === "game.character.read") {
        const falling = read++ > 0;
        return {
          character: {
            CFrame: { Position: { X: falling ? 300 : 0, Y: falling ? -36 : 84, Z: 0 } },
            standingOn: falling ? null : { instanceName: "Roof", distance: 0 },
          },
        };
      }
      return { requestId: "req-44", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 300, y: 84, z: 0 },
    });

    expect(result.output).toContain('"endedInAir": true');
    expect(result.output).toContain("falling rather");
  });

  test("move_to stays quiet about the ground when there is some", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-45", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return {
          character: {
            CFrame: { Position: { X: 0, Y: 84, Z: 0 } },
            standingOn: { instanceName: "Roof", distance: 0 },
          },
        };
      }
      return { requestId: "req-45", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 0, y: 84, z: 0 },
    });

    expect(result.output).not.toContain('"endedInAir"');
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

    const result = await run(byName.get("studiorpc_game_character_move_to"), { target: "Coin1" });

    const sent = calls.find((call) => call.method === "game.character.moveTo");
    expect((sent?.params as { position: unknown }).position).toMatchObject({ x: 350, y: 60, z: 250 });
    // Distances are to the surface, so standing at the centre reads 0, and the
    // tolerance is the touch margin rather than anything derived from the size.
    expect(result.output).toContain('"distanceToTarget": 0');
    expect(result.output).toContain('"arrivedWithin": 60');
    expect(result.output).toContain('"targetPosition"');
  });

  test("move_to measures a big target from its surface, not its middle", async () => {
    // A gate 400 wide: half of it is 200, so measuring to the centre called a
    // character arrived while it stood well clear of the thing it was sent to.
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.instance.read") {
        return { instance: { CFrame: { Position: { X: 0, Y: 200, Z: -600 } }, Size: { X: 400, Y: 400, Z: 40 } } };
      }
      if (call.method === "game.character.moveTo") return { requestId: "req-23", status: "pendingStart" };
      if (call.method === "game.character.read") {
        // Stopped 130 short of the near face: 150 from the centre plane, less the
        // 20 half-depth. Under the old centre measure this was "arrived".
        return { character: { CFrame: { Position: { X: 0, Y: 200, Z: -450 } } } };
      }
      return { requestId: "req-23", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), { target: "Gate" });

    expect(result.output).toContain('"distanceToTarget": 130');
    expect(result.output).toContain('"arrived": false');
    expect(result.output).toContain('"outcome": "blocked"');
  });

  test("move_to says so when the named instance is not in the world", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.instance.read") return {};
      return { requestId: "req-21", status: "reached", clientId: "client-1" };
    });

    await expect(run(byName.get("studiorpc_game_character_move_to"), { target: "Nope" })).rejects.toThrow(
      /[Nn]othing in the running Workspace is called "Nope"/,
    );
  });

  test("move_to emits every field its own description tells callers to read", async () => {
    // `arrived` was documented as the field to prefer over `status` and was never
    // emitted, so testers recomputed it from distance and tolerance by hand.
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-22", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 1000, Y: 0, Z: 5 } } } };
      }
      return { requestId: "req-22", status: "reached", clientId: "client-1" };
    });

    const tool = byName.get("studiorpc_game_character_move_to");
    const result = await run(tool, { target: { x: 1000, y: 0, z: 5 } });

    expect(result.output).toContain('"outcome": "arrived"');
    for (const field of [
      "outcome",
      "arrived",
      "blocked",
      "moved",
      "movedDistance",
      "distanceToTarget",
      "arrivedWithin",
    ]) {
      expect(tool?.description).toContain(field);
      expect(result.output).toContain(`"${field}"`);
    }
    expect(result.output).toContain('"arrived": true');
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
      target: { x: 5000, y: 0, z: 0 },
      timeoutMs: 60_000,
    });

    expect(result.output).toContain('"blocked": true');
    expect(result.output).toContain('"outcome": "blocked"');
    expect(result.output).toContain('"navStatus": "blocked"');
    expect(result.output).toContain('"rawNavStatus": "running"');
    expect(result.output).toContain("stuck rather than slow");
    // It must not have burned the full minute to say so.
    const waited = Number(/"waitedMs": (\d+)/.exec(result.output)?.[1] ?? 0);
    expect(waited).toBeLessThan(30_000);
  });

  // An arrived move still says "arrived", not "stalled" — but the wait it reports is two numbers
  // added together whenever Studio never returns a terminal status, and only one of them is travel.
  // A run once reported waitedMs as "not proportional to distance" off exactly this: measured on
  // playtest2, the same 1201 units took 2595ms one way and 5868ms the other, twice each, and the
  // whole difference was the stall window sitting inside the second number.
  test("an arrived move that had to wait out the stall window separates travel from waiting", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-stall", status: "pendingStart" };
      // Parked inside the tolerance and not moving, while navigation keeps saying running.
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 0, Y: 0, Z: 0 } } } };
      }
      return { requestId: "req-stall", status: "running", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 100, y: 0, z: 0 },
      timeoutMs: 30_000,
    });

    const parsed = JSON.parse(result.output);
    expect(parsed.arrived).toBe(true);
    expect(parsed.stallWindowMs).toBe(3_000);
    // waitedMs = travelMs + stallWindowMs, so the reader can budget travel from the first.
    expect(parsed.travelMs).toBe(parsed.waitedMs - parsed.stallWindowMs);
    // The word still stays away from an arrived move; only the time is published.
    expect(result.output).not.toContain('"stalled"');
  }, 20_000);

  test("move_to does not call normal low-time-scale movement stalled", async () => {
    let x = 0;
    const { calls, byName } = toolsFor((call) => {
      // The scale now rides on the status call; game.time.scale no longer exists.
      if (call.method === "game.pie.status") return runningStatus({ timeScale: 0.05 });
      if (call.method === "game.character.moveTo") return { requestId: "req-slow", status: "pendingStart" };
      if (call.method === "game.character.read") {
        // Four units per poll is below MOVED_AT_ALL for every individual sample,
        // but it is steady travel when the world is running at 0.05 speed.
        x += 4;
        return { character: { CFrame: { Position: { X: x, Y: 0, Z: 0 } } } };
      }
      return { requestId: "req-slow", status: "running", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 5000, y: 0, z: 0 },
      timeoutMs: 1_000,
    });

    expect(calls.some((call) => call.method === "game.pie.status")).toBe(true);
    expect(result.output).toContain('"outcome": "stillMoving"');
    expect(result.output).toContain('"stallWindowMs": 60000');
    expect(result.output).toContain('"gameTimeScale": 0.05');
    expect(result.output).not.toContain('"stalled"');
    expect(result.output).not.toContain('"blocked"');
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
      target: { x: 5000, y: 0, z: 0 },
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
      target: { x: 5000, y: 0, z: 0 },
    });

    expect(result.output).toContain("no navigation data");
  });

  // `wait` and `passThroughBeyond` were removed. Without a strict schema they would be dropped
  // in silence: a caller asking not to wait would be waited on anyway, and one shortening the
  // overshoot would get the default. A removed parameter has to refuse, not shrug.
  test("parameters that were removed are refused rather than ignored", async () => {
    const { byName } = toolsFor((call) =>
      call.method === "game.pie.status" ? runningStatus() : { requestId: "req-2", status: "pendingStart" },
    );

    // Checked against the schema rather than through run(), which calls execute() directly and
    // never validates — a test that went through run() would have passed whatever the schema said.
    const schema = byName.get("studiorpc_game_character_move_to")?.parameters as {
      parse: (value: unknown) => unknown;
    };
    for (const gone of [
      { wait: false },
      { passThroughBeyond: 40 },
      { targetName: "Gate" },
      { position: { x: 0, y: 0, z: 0 } },
    ]) {
      expect(() => schema.parse({ target: "Gate", ...gone })).toThrow(/[Uu]nrecognized/);
    }
  });

  test("where to walk is one parameter, so it cannot be answered twice", async () => {
    const { byName } = toolsFor((call) => (call.method === "game.pie.status" ? runningStatus() : {}));
    const schema = byName.get("studiorpc_game_character_move_to")?.parameters as {
      parse: (value: unknown) => unknown;
    };

    // Both forms still reach the tool; they are just the same parameter now.
    expect(() => schema.parse({ target: "PressurePump" })).not.toThrow();
    expect(() => schema.parse({ target: { x: 100, y: 84, z: 300 } })).not.toThrow();
    // The shape that made the merge necessary: gpt-5.6-terra walked to PressurePump and to the
    // origin in one call, and the origin was silently ignored.
    expect(() => schema.parse({ target: "PressurePump", position: { x: 0, y: 0, z: 0 } })).toThrow();
    // And it has to be answered once — this is the only way to say where.
    expect(() => schema.parse({ timeoutMs: 5000 })).toThrow();
  });

  test("move_to reports the still-running move when its wait budget runs out", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-3", status: "pendingStart" };
      return { requestId: "req-3", status: "running", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 1, y: 2, z: 3 },
      timeoutMs: 1000,
    });

    expect(result.metadata).toMatchObject({ status: "running" });
    // What to do about it is now stated in place of a tool to call.
    expect(result.output).toContain("larger timeoutMs");
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

  test("inject gives a press without a duration enough time for UI activation", async () => {
    const { calls, byName } = toolsFor((call) => (call.method === "game.pie.status" ? runningStatus() : {}));

    await run(byName.get("studiorpc_game_input_inject"), {
      events: [{ type: "pointerButton", button: "left", action: "press" }],
    });

    expect(calls[1].params?.events).toEqual([
      { type: "pointerButton", button: "left", action: "down" },
      { type: "wait", durationMs: 100 },
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

  test("a blocked look at the end of a batch is an answer, not a failure", async () => {
    // Verbatim from the playtest7 run: one look event, alone, against a game with a fixed
    // camera. Studio failed the inject saying "the 0 event(s) behind it were cancelled" — a
    // sentence that names the whole reason for the failure and then counts it at zero.
    const blockedLook = new StudioRpcError(
      "Studio RPC error [-32108]: The look did not land, so the 0 event(s) behind it were cancelled. " +
        "The view never moved: this game does not take mouse-look.",
      -32108,
      {
        looks: [
          {
            status: "blocked",
            requested: { yawDegrees: 45, pitchDegrees: 0 },
            turned: { yawDegrees: 0, pitchDegrees: 0 },
            facing: { yaw: 0, pitch: 0 },
          },
        ],
      },
    );
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      throw blockedLook;
    });

    const result = await run(byName.get("studiorpc_game_input_inject"), {
      events: [{ type: "look", yawDegrees: 45, pitchDegrees: 0, timeoutMs: 1000 }],
    });

    const output = JSON.parse(result.output as string);
    expect(output.looks[0].status).toBe("blocked");
    expect(output.status).toBe("blocked");
    // The run that met this reported it under "confusing test-tool support" rather than as the
    // finding it was: the game has a fixed camera, which is what it had set out to check.
    expect(result.output).not.toContain("unexpected error");
  });

  test("a look that stopped short mid-batch stays a failure, because the tail was dropped", async () => {
    const cancelledTail = new StudioRpcError(
      "Studio RPC error [-32108]: The look did not land, so the 2 event(s) behind it were cancelled.",
      -32108,
      { looks: [{ status: "timedOut", turned: { yawDegrees: 123 } }] },
    );
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      throw cancelledTail;
    });

    // The batch ends in a key, so events really did go unsent and the caller has to know.
    await expect(
      run(byName.get("studiorpc_game_input_inject"), {
        events: [
          { type: "look", yawDegrees: 180, timeoutMs: 800 },
          { type: "key", key: "F", action: "press", durationMs: 100 },
        ],
      }),
    ).rejects.toThrow(/2 event\(s\) behind it were cancelled/);
  });

  test("a pointer failure is still a failure, even as the last event", async () => {
    // The look is recoverable because the event happened and blocked is its answer. A pointer
    // that could not be clicked did not happen at all, and there is no answer in that.
    const hidden = new StudioRpcError(
      'Studio RPC error [-32108]: "Parcel" exists but cannot be clicked where it is: it is hidden.',
      -32108,
      { pointerTargets: [{ target: "Parcel" }] },
    );
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      throw hidden;
    });

    await expect(
      run(byName.get("studiorpc_game_input_inject"), {
        events: [{ type: "pointerButton", button: "left", action: "press", target: "Parcel" }],
      }),
    ).rejects.toThrow(/cannot be clicked/);
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
