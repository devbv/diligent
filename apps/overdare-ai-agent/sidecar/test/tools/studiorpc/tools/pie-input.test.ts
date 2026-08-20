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
import { inputEventsSchema } from "../../../../src/tools/studiorpc/tools/pie-input/events";

interface RpcCall {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
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
  const callRpc = async (
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => {
    const call: RpcCall = { method, params, timeoutMs: options?.timeoutMs, signal: options?.signal };
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
    expect(normalizeWaitedMoveStatus("arrived")).toBe("reached");
    expect(normalizeWaitedMoveStatus("navigationGaveUp")).toBe("navigationGaveUp");
    expect(normalizeWaitedMoveStatus("stoppedShort")).toBe("stoppedShort");
    expect(normalizeWaitedMoveStatus("timedOut")).toBe("cancelled");
  });

  test("expresses the stall window in game time when the world is slowed", () => {
    expect(moveStallWindowMs(1)).toBe(3_000);
    expect(moveStallWindowMs(10)).toBe(3_000);
    expect(moveStallWindowMs(0.2)).toBe(15_000);
    expect(moveStallWindowMs(0.05)).toBe(60_000);
    expect(moveStallWindowMs(undefined)).toBe(3_000);
  });

  test("validates every wait condition shape before it reaches Studio", () => {
    expect(() =>
      inputEventsSchema.parse([{ type: "wait", durationMs: 1_000, until: { instance: "Gate", exists: true } }]),
    ).not.toThrow();
    expect(() =>
      inputEventsSchema.parse([{ type: "wait", durationMs: 1_000, until: { ui: "HUD", visible: true } }]),
    ).not.toThrow();
    expect(() =>
      inputEventsSchema.parse([{ type: "wait", durationMs: 1_000, until: { ui: "HUD", onScreen: false } }]),
    ).not.toThrow();
    expect(() =>
      inputEventsSchema.parse([
        { type: "wait", durationMs: 1_000, until: { instance: "Gate", property: "CanCollide" } },
      ]),
    ).toThrow();
    expect(() =>
      inputEventsSchema.parse([
        {
          type: "wait",
          durationMs: 1_000,
          until: { instance: "Gate", property: "Transparency", equals: 0, atMost: 1 },
        },
      ]),
    ).toThrow();
  });

  test("are registered on the Studio RPC provider", async () => {
    const provider = createStudioRpcToolProvider({ callRpc: async () => ({}) });
    const names = (await provider.createTools({ cwd: "/tmp/project" })).map((tool) => tool.name);

    expect(names).toContain("studiorpc_game_pie_status");
    expect(names).toContain("studiorpc_game_input_inject");
    expect(names).toContain("studiorpc_game_character_move_to");
    expect(names).not.toContain("studiorpc_game_character_move_status");
    expect(names).not.toContain("studiorpc_game_input_release_all");
  });

  test("inject resolves the live session and first injectable client when ids are omitted", async () => {
    const { calls, byName } = toolsFor((call) =>
      call.method === "game.pie.status"
        ? runningStatus()
        : { sequenceId: "seq-1", status: "completed", appliedEventCount: 3 },
    );

    const result = await run(byName.get("studiorpc_game_input_inject"), { events: walkForward });

    expect(calls.find((call) => call.method === "game.input.inject")?.signal).toBe(ctx.signal);

    expect(calls.map((call) => call.method)).toEqual(["game.pie.status", "game.input.inject"]);
    expect(calls[1].params).toMatchObject({ pieSessionId: "pie-1", clientId: "client-1", events: walkForward });
    expect(result.metadata).toMatchObject({ clientId: "client-1", eventCount: 3, status: "completed" });
  });

  test("inject accepts a pointer event written with flat x and y", async () => {
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

  test("inject rejects waits summing past the batch time limit", async () => {
    const { byName } = toolsFor(() => runningStatus());

    await expect(
      run(byName.get("studiorpc_game_input_inject"), {
        events: [
          { type: "key", key: "W", action: "down" },
          { type: "wait", durationMs: 40000 },
          { type: "wait", durationMs: 25000 },
          { type: "key", key: "W", action: "up" },
        ],
      }),
    ).rejects.toThrow(/totalDurationExceeded/);
  });
  test("inject reports the batch limit against the event the caller wrote", async () => {
    const { byName } = toolsFor(() => runningStatus());

    await expect(
      run(byName.get("studiorpc_game_input_inject"), {
        events: [
          { type: "key", key: "W", action: "press", durationMs: 60 },
          { type: "wait", durationMs: 60000 },
        ],
      }),
    ).rejects.toThrow(/events\[1\]: the batch spends 60060ms/);
  });

  test("inject says press holds count toward the batch limit", async () => {
    const { byName } = toolsFor(() => runningStatus());

    await expect(
      run(byName.get("studiorpc_game_input_inject"), {
        events: [
          { type: "key", key: "W", action: "press", durationMs: 60 },
          { type: "wait", durationMs: 60000 },
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

  test("inject counts look budgets toward the batch time limit", async () => {
    const { byName } = toolsFor(() => runningStatus());

    await expect(
      run(byName.get("studiorpc_game_input_inject"), {
        events: [
          { type: "look", yawDegrees: 90, timeoutMs: 5000 },
          { type: "look", yawDegrees: 90, timeoutMs: 5000 },
          { type: "wait", durationMs: 51000 },
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
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 0, Y: 0, Z: 0 } } } };
      }
      return { requestId: "req-1", status: statuses[Math.min(polls++, statuses.length - 1)], clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), { target: { x: 100, y: 200, z: 300 } });

    expect(calls.filter((call) => call.method === "game.character.moveStatus")).toHaveLength(3);
    expect(result.metadata).toMatchObject({ requestId: "req-1", status: "navigationGaveUp" });
  });
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
    expect(result.metadata).toMatchObject({ status: "reached", clientId: "client-2" });
    expect(JSON.parse(result.output)).toMatchObject({ arrived: true, outcome: "arrived" });
  });

  test("move_to checks Studio's reached against where the character actually stopped", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-9", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 10, Y: 0, Z: 5 } } } };
      }
      return { requestId: "req-9", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 1000, y: 0, z: 5 },
    });

    expect(result.output).toContain('"distanceToTarget"');
    expect(result.output).toContain('"outcome": "navigationGaveUp"');
    expect(result.output).not.toContain('"rawNavStatus"');
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

    expect(result.output).toContain('"outcome": "arrived"');
    expect(result.output).toContain('"distanceToTarget": 0');
    expect(result.output).not.toContain('"rawNavStatus"');
  });
  test("move_to says when a move never set off, and does not round its numbers into a contradiction", async () => {
    const parked = (call: { method: string }) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.instance.read") {
        return { instance: { CFrame: { Position: { X: 1000, Y: 0, Z: 5 } }, Size: { X: 10, Y: 10, Z: 10 } } };
      }
      if (call.method === "game.character.moveTo") return { requestId: "req-80", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 934.9, Y: 0, Z: 5 } } } };
      }
      return { requestId: "req-80", status: "reached", clientId: "client-1" };
    };

    const result = await run(toolsFor(parked).byName.get("studiorpc_game_character_move_to"), { target: "Bed" });
    expect(result.output).toContain('"distanceToTarget": 60.1');
    expect(result.output).toContain('"arrivedWithin": 60');
    expect(result.output).toContain('"arrived": false');
    expect(result.output).toContain('"didNotSetOff": true');
    expect(result.output).toContain('"declinedToWalk": true');
  });
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
    expect(result.output).toContain('"declinedToWalk": false');
  });

  test("move_to separates a move that was unnecessary from one that went nowhere", async () => {
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
    expect(alreadyThere.output).toContain('"outcome": "arrived"');

    const stuck = await run(toolsFor(parked({ X: 0, Z: 0 })).byName.get("studiorpc_game_character_move_to"), {
      target: { x: 5000, y: 0, z: 0 },
    });
    expect(stuck.output).toContain('"outcome": "navigationGaveUp"');
    expect(stuck.output).toContain('"didNotSetOff": true');
  });
  test("every distance navigation settles at is already an arrival", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.instance.read") {
        return { instance: { CFrame: { Position: { X: 1000, Y: 0, Z: 5 } }, Size: { X: 10, Y: 10, Z: 10 } } };
      }
      if (call.method === "game.character.moveTo") return { requestId: "req-14", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 950, Y: 0, Z: 5 } } } };
      }
      return { requestId: "req-14", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), { target: "Terminal" });

    expect(result.output).toContain('"arrived": true');
    expect(result.output).toContain('"outcome": "arrived"');
  });

  test("move_to reports a character that walked into a wall as blocked", async () => {
    let read = 0;
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-16", status: "pendingStart" };
      if (call.method === "game.character.read") {
        const x = read++ === 0 ? 0 : 800;
        return { character: { CFrame: { Position: { X: x, Y: 0, Z: 0 } } } };
      }
      return { requestId: "req-16", status: "timedOut", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 1000, y: 0, z: 0 },
    });

    expect(result.output).toContain('"outcome": "navigationGaveUp"');
    expect(result.output).not.toContain('"didNotSetOff"');
  });
  test("move_to counts standing on the target as arriving at it", async () => {
    let read = 0;
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-30", status: "pendingStart" };
      if (call.method === "game.instance.read") {
        return { instance: { CFrame: { Position: { X: 150, Y: 20, Z: 0 } }, Size: { X: 80, Y: 40, Z: 80 } } };
      }
      if (call.method === "game.character.read") {
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
    expect(result.output).toContain('"standingOn": "PlinthMid"');
    expect(result.output).toContain('"distanceToTarget": 84');
    expect(result.output).toContain('"arrivalReason": "standingOnTarget"');
  });

  test("move_to names the radius when that is what decided", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-30b", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return {
          character: { CFrame: { Position: { X: 0, Y: 84, Z: 0 } }, standingOn: { instanceName: "Lane", distance: 0 } },
        };
      }
      return { requestId: "req-30b", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), { target: { x: 0, y: 84, z: 0 } });

    expect(result.output).toContain('"outcome": "arrived"');
    expect(result.output).toContain('"arrivalReason": "withinRadius"');
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

    expect(result.output).toContain('"outcome": "navigationGaveUp"');
    expect(result.output).not.toContain('"standingOnTarget"');
    expect(result.output).not.toContain('"arrivalReason"');
  });
  test("move_to says so when the character was moved rather than walked partway through", async () => {
    const walk = [
      { X: 0, Y: 84, Z: 0 },
      { X: 150, Y: 84, Z: 0 },
      { X: 300, Y: 84, Z: 0 },
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
    });
    const parsed = JSON.parse(result.output as string);
    const xs = (parsed.characterTrack as { x: number }[]).map((sample) => sample.x);
    expect(Math.min(...xs)).toBeLessThanOrEqual(-900);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(300);
    expect(result.output).not.toContain("respawnedMidMove");
  });

  test("move_to reports the walked length when the route was longer than the line", async () => {
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
    const parsed = JSON.parse(result.output as string);
    const corner = (parsed.characterTrack as { x: number; z: number }[]).some(
      (sample) => sample.x === 0 && sample.z === 300,
    );
    expect(corner).toBe(true);
    expect(result.output).not.toContain("walkedDistance");
  });
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
    });

    expect(result.output).toContain('"alreadyAtTarget": "ParcelRed"');
  });
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

    expect(result.output).toContain('"standingOn": null');
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

    expect(result.output).toContain('"standingOn": "Roof"');
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
    expect(result.output).toContain('"distanceToTarget": 0');
    expect(result.output).toContain('"arrivedWithin": 60');
  });

  test("move_to measures a big target from its surface, not its middle", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.instance.read") {
        return { instance: { CFrame: { Position: { X: 0, Y: 200, Z: -600 } }, Size: { X: 400, Y: 400, Z: 40 } } };
      }
      if (call.method === "game.character.moveTo") return { requestId: "req-23", status: "pendingStart" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 0, Y: 200, Z: -450 } } } };
      }
      return { requestId: "req-23", status: "reached", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), { target: "Gate" });

    expect(result.output).toContain('"distanceToTarget": 130');
    expect(result.output).toContain('"arrived": false');
    expect(result.output).toContain('"outcome": "navigationGaveUp"');
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
    for (const field of ["outcome", "arrived", "distanceToTarget", "arrivedWithin", "standingOn"]) {
      expect(tool?.description).toContain(field);
      expect(result.output).toContain(`"${field}"`);
    }
    expect(result.output).toContain('"arrived": true');
  });

  test("move_to gives up on a character that has stopped moving", async () => {
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

    expect(result.output).toContain('"outcome": "navigationGaveUp"');
    expect(result.output).not.toContain('"rawNavStatus"');
  });
  test("an arrived move stays arrived when the wait was cut by the stall window", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-stall", status: "pendingStart" };
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
    expect(parsed.outcome).toBe("arrived");
    expect(result.output).not.toContain('"stalled"');
  }, 20_000);

  test("move_to does not call normal low-time-scale movement stalled", async () => {
    let x = 0;
    const { calls, byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus({ timeScale: 0.05 });
      if (call.method === "game.character.moveTo") return { requestId: "req-slow", status: "pendingStart" };
      if (call.method === "game.character.read") {
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
    expect(result.output).toContain('"outcome": "timedOut"');
    expect(result.output).not.toContain('"stalled"');
    expect(result.output).not.toContain('"blocked"');
  });

  test("move_to withholds an arrival verdict on a move it had to stop", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-15", status: "pendingStart" };
      if (call.method === "game.character.moveCancel") return { requestId: "req-15", status: "cancelled" };
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
    expect(result.output).not.toContain('"arrived"');
    expect(result.output).toContain('"endedAt"');
    expect(result.output).toContain('"outcome": "timedOut"');
  });

  test("move_to cancels the route its wait ran out on", async () => {
    const { calls, byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-cancel", status: "pendingStart" };
      if (call.method === "game.character.moveCancel") return { requestId: "req-cancel", status: "cancelled" };
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 1, Y: 0, Z: 0 } } } };
      }
      return { requestId: "req-cancel", status: "running", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 5000, y: 0, z: 0 },
      timeoutMs: 1_000,
    });

    const cancel = calls.find((call) => call.method === "game.character.moveCancel");
    expect(cancel?.params).toMatchObject({ requestId: "req-cancel" });
    expect(result.output).toContain('"outcome": "timedOut"');
    expect(result.output).not.toContain('"routeStillRunning"');
  });

  test("move_to keeps a terminal status that wins the timeout-cancel race", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-race", status: "pendingStart" };
      if (call.method === "game.character.moveCancel") return { requestId: "req-race", status: "reached" };
      if (call.method === "game.character.read") {
        return {
          character: {
            CFrame: { Position: { X: 5_000, Y: 0, Z: 0 } },
            standingOn: { instanceName: "Goal" },
          },
        };
      }
      return { requestId: "req-race", status: "running", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 5_000, y: 0, z: 0 },
      timeoutMs: 1_000,
    });

    expect(result.output).toContain('"outcome": "arrived"');
    expect(result.output).toContain('"arrived": true');
    expect(result.output).not.toContain('"routeStillRunning"');
  });

  test("move_to says so when it could not stop the route", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-nocancel", status: "pendingStart" };
      if (call.method === "game.character.moveCancel") throw new Error("moveRequestNotFound");
      if (call.method === "game.character.read") {
        return { character: { CFrame: { Position: { X: 1, Y: 0, Z: 0 } } } };
      }
      return { requestId: "req-nocancel", status: "running", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 5000, y: 0, z: 0 },
      timeoutMs: 1_000,
    });

    expect(result.output).toContain('"outcome": "timedOut"');
    expect(result.output).toContain('"routeStillRunning": true');
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

    expect(result.output).toContain('"didNotSetOff": true');
    expect(result.output).toContain('"declinedToWalk": true');
  });
  test("parameters that were removed are refused rather than ignored", async () => {
    const { byName } = toolsFor((call) =>
      call.method === "game.pie.status" ? runningStatus() : { requestId: "req-2", status: "pendingStart" },
    );
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
    expect(() => schema.parse({ target: "PressurePump" })).not.toThrow();
    expect(() => schema.parse({ target: { x: 100, y: 84, z: 300 } })).not.toThrow();
    expect(() => schema.parse({ target: "PressurePump", position: { x: 0, y: 0, z: 0 } })).toThrow();
    expect(() => schema.parse({ timeoutMs: 5000 })).toThrow();
  });

  test("move_to reports a stopped route when its wait budget runs out", async () => {
    const { byName } = toolsFor((call) => {
      if (call.method === "game.pie.status") return runningStatus();
      if (call.method === "game.character.moveTo") return { requestId: "req-3", status: "pendingStart" };
      return { requestId: "req-3", status: "running", clientId: "client-1" };
    });

    const result = await run(byName.get("studiorpc_game_character_move_to"), {
      target: { x: 1, y: 2, z: 3 },
      timeoutMs: 1000,
    });
    expect(result.metadata).toMatchObject({ status: "cancelled" });
    expect(result.output).toContain('"outcome": "timedOut"');
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

  test("a look with no timeoutMs is budgeted from the angle it asks for", async () => {
    const { calls, byName } = toolsFor((call) => (call.method === "game.pie.status" ? runningStatus() : {}));

    await run(byName.get("studiorpc_game_input_inject"), {
      events: [
        { type: "look", yawDegrees: 180 },
        { type: "look", yawDegrees: 15 },
      ],
    });

    const sent = calls.find((call) => call.method === "game.input.inject")?.params?.events as Array<{
      timeoutMs?: number;
    }>;
    expect(sent[0].timeoutMs).toBe(4000);
    expect(sent[1].timeoutMs).toBe(2000);
  });

  test("a look asking for less time than its angle takes is raised, not refused", async () => {
    const { calls, byName } = toolsFor((call) =>
      call.method === "game.pie.status" ? runningStatus() : { sequenceId: "seq-raise", status: "completed" },
    );

    const result = await run(byName.get("studiorpc_game_input_inject"), {
      events: [{ type: "look", yawDegrees: 180, timeoutMs: 1200 }],
    });

    const sent = calls.find((call) => call.method === "game.input.inject")?.params?.events as Array<{
      timeoutMs?: number;
    }>;
    expect(sent[0].timeoutMs).toBe(4000);
    expect(result.output).toContain('"raisedLookTimeouts"');
    expect(result.output).toContain('"from": 1200');
    expect(result.output).toContain('"to": 4000');
  });

  test("a look with a big enough budget of its own keeps it, and says nothing", async () => {
    const { calls, byName } = toolsFor((call) =>
      call.method === "game.pie.status" ? runningStatus() : { sequenceId: "seq-keep", status: "completed" },
    );

    const result = await run(byName.get("studiorpc_game_input_inject"), {
      events: [{ type: "look", yawDegrees: 90, timeoutMs: 4500 }],
    });

    const sent = calls.find((call) => call.method === "game.input.inject")?.params?.events as Array<{
      timeoutMs?: number;
    }>;
    expect(sent[0].timeoutMs).toBe(4500);
    expect(result.output).not.toContain('"raisedLookTimeouts"');
  });

  test("a blocked look at the end of a batch is an answer, not a failure", async () => {
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
      events: [{ type: "look", yawDegrees: 45, pitchDegrees: 0 }],
    });

    const output = JSON.parse(result.output as string);
    expect(output.looks[0].status).toBe("blocked");
    expect(output.status).toBe("blocked");
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
    await expect(
      run(byName.get("studiorpc_game_input_inject"), {
        events: [
          { type: "look", yawDegrees: 180, timeoutMs: 4000 },
          { type: "key", key: "F", action: "press", durationMs: 100 },
        ],
      }),
    ).rejects.toThrow(/2 event\(s\) behind it were cancelled/);
  });

  test("a pointer failure is still a failure, even as the last event", async () => {
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
  test("the live world is read through one tool, not three", async () => {
    const { tools } = await providerTools({});
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("studiorpc_viewport_camera_read");
    expect(names).toContain("studiorpc_game_observe");
    expect(names).not.toContain("studiorpc_game_instance_read");
    expect(names).not.toContain("studiorpc_game_ui_browse");
  });

  test("camera_read names what the screen center is on", async () => {
    const { tools } = await providerTools({
      camera: {
        CFrame: { Position: { x: 0, y: 0, z: 100 }, Orientation: { x: 0, y: 0, z: 0 } },
        centerHit: { position: { x: 0, y: 1250, z: 100 }, instanceName: "Baseplate" },
      },
    });
    const camera = tools.find((tool) => tool.name === "studiorpc_viewport_camera_read");

    const result = await camera?.execute({} as never, ctx as never);
    const items = result?.render?.blocks?.flatMap((block) => ("items" in block ? block.items : []));

    expect(result?.render?.outputSummary).toBe("looking at Baseplate");
    expect(items).toContainEqual({ key: "centerHit", value: "Baseplate" });
  });
});
