// @summary Tests for handleConfigReload — clears cached per-thread agents on reload success

import { describe, expect, test } from "bun:test";
import { handleConfigReload } from "../../src/app-server/config-handlers";
import type { ThreadRuntime } from "../../src/app-server/thread-handlers";

function fakeRuntime(agent: unknown): ThreadRuntime {
  return { agent } as unknown as ThreadRuntime;
}

describe("handleConfigReload", () => {
  test("throws when the host does not support reloadConfig", async () => {
    await expect(handleConfigReload(undefined, new Map())).rejects.toThrow(
      "Config reload is not supported by this app server.",
    );
  });

  test("returns the reloaded skills and clears every thread's cached agent", async () => {
    const threads = new Map<string, ThreadRuntime>([
      ["t1", fakeRuntime({ id: "agent-1" })],
      ["t2", fakeRuntime({ id: "agent-2" })],
    ]);
    const reloadConfig = async () => ({
      skills: [{ name: "write-plan", description: "Create implementation plans" }],
    });

    const result = await handleConfigReload(reloadConfig, threads);

    expect(result).toEqual({ skills: [{ name: "write-plan", description: "Create implementation plans" }] });
    expect(threads.get("t1")?.agent).toBeUndefined();
    expect(threads.get("t2")?.agent).toBeUndefined();
  });
});
