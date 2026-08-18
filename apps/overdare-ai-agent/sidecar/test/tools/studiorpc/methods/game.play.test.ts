// @summary Tests that restart really stops first, and that Studio never sees the flag.
import { describe, expect, test } from "bun:test";
import { normalizeArgs, params, preCall } from "../../../../src/tools/studiorpc/methods/game.play";

describe("game.play restart", () => {
  test("stops the running session before starting one", async () => {
    const calls: string[] = [];
    await preCall({ restart: true, timeScale: 0.2 }, async (method) => {
      calls.push(method);
      return {};
    });

    expect(calls).toEqual(["game.stop"]);
  });

  test("leaves a running session alone when it is not asked to restart", async () => {
    const calls: string[] = [];
    const record = async (method: string) => {
      calls.push(method);
      return {};
    };
    // 59 of 140 measured plays landed on an already-running session on purpose, to rescale
    // its clock. Stopping those would throw away the state they were about to read.
    await preCall({ timeScale: 0.2 }, record);
    await preCall({ restart: false }, record);

    expect(calls).toEqual([]);
  });

  test("restarting from a stopped session starts it, rather than failing to stop it", async () => {
    // Studio refuses game.stop when nothing is running. Raising that would make `restart: true`
    // fail from exactly the state the caller cannot distinguish — which is why the flag exists:
    // a caller that knew a play test was up would have called game.stop itself.
    const calls: string[] = [];
    await preCall({ restart: true }, async (method) => {
      calls.push(method);
      throw new Error("Studio RPC error [-32130]: No play test is running.");
    });
    expect(calls).toEqual(["game.stop"]);
  });

  test("restart never reaches Studio, which does not know the flag", () => {
    expect(normalizeArgs({ restart: true, timeScale: 0.2 })).toEqual({ timeScale: 0.2 });
  });

  test("states the clock range it enforces", () => {
    expect(() => params.parse({ timeScale: 10 })).not.toThrow();
    // Codex asked for 20, and the refusal left the play test stopped — the range is in the
    // description now because the failure costs the call after it as well.
    expect(() => params.parse({ timeScale: 20 })).toThrow();
    expect(() => params.parse({ timeScale: 0.04 })).toThrow();
  });
});
