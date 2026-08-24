// @summary Tests that restart really stops first, and that Studio never sees the flag.
import { describe, expect, test } from "bun:test";
import { normalizeArgs, params, preCall } from "../../../../src/tools/studiorpc/methods/game.play";

describe("game.play restart", () => {
  test("stops the running session before starting one", async () => {
    const calls: string[] = [];
    await preCall({ restart: true, numberOfPlayer: 2 }, async (method) => {
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
    await preCall({ numberOfPlayer: 2 }, record);
    await preCall({ restart: false }, record);

    expect(calls).toEqual([]);
  });

  test("does not start when the required stop could not be confirmed", async () => {
    await expect(
      preCall({ restart: true }, async () => {
        throw new Error("Studio RPC connection failed");
      }),
    ).rejects.toThrow("connection failed");
  });

  test("restart never reaches Studio, which does not know the flag", () => {
    expect(normalizeArgs({ restart: true, numberOfPlayer: 2 })).toEqual({ numberOfPlayer: 2 });
  });

  test("strips the removed timeScale parameter before calling Studio", () => {
    expect(params.parse({ numberOfPlayer: 2, timeScale: 10 })).toEqual({ numberOfPlayer: 2 });
  });
});
