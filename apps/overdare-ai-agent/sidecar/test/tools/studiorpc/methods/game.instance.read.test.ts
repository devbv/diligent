// @summary Tests that the live instance read accepts the GUID name its sibling tool uses.
import { describe, expect, test } from "bun:test";
import { normalizeArgs, params, recover } from "../../../../src/tools/studiorpc/methods/game.instance.read";

describe("game.instance.read arguments", () => {
  test("accepts guid, which is what studiorpc_instance_read calls it", () => {
    // Params are strict, so an alias only normalizeArgs knows about is rejected by
    // validation before normalizeArgs runs. It has to be declared as well.
    expect(() => params.parse({ guid: "87979D270CFA5340AC20E34C29E8C092" })).not.toThrow();

    const normalized = normalizeArgs({ guid: "87979D270CFA5340AC20E34C29E8C092" });
    expect(normalized.instanceGuid).toBe("87979D270CFA5340AC20E34C29E8C092");
    // Studio knows nothing about `guid`, so it must not reach the wire.
    expect(normalized.guid).toBeUndefined();
  });

  test("leaves instanceGuid alone when both are given", () => {
    expect(normalizeArgs({ instanceGuid: "AAA", guid: "BBB" }).instanceGuid).toBe("AAA");
  });

  test("still takes a name, and no arguments at all", () => {
    expect(() => params.parse({ name: "Gate" })).not.toThrow();
    expect(() => params.parse({})).not.toThrow();
  });
});

describe("game.instance.read on a name that is not there", () => {
  // Verbatim from the wire: the transport appends the request envelope to every error.
  const missing = new Error(
    'Studio RPC error [-32150]: No instance named "TurretMid" is in the running Workspace.\n\n' +
      'Request was:\n{"jsonrpc":"2.0","id":1,"method":"game.instance.read","params":{"name":"TurretMid"}}',
  );
  const workspace = {
    instances: [
      { name: "PlinthMid" },
      { name: "TurretMID" },
      { name: "Crystal" },
      { name: "Lane" },
      { name: "Spawner" },
    ],
  };

  test("answers found: false instead of raising", async () => {
    const result = (await recover(missing, { name: "TurretMid" }, async () => workspace)) as Record<string, unknown>;

    // Run 44 used the thrown error as its "the turret is gone" signal, which made
    // every existence check an error path.
    expect(result.found).toBe(false);
    expect(result.name).toBe("TurretMid");
    // The answer carries Studio's sentence, not the JSON-RPC envelope behind it.
    expect(result.note).toContain('No instance named "TurretMid"');
    expect(result.note).not.toContain("jsonrpc");
  });

  test("offers the names that are there, nearest first", async () => {
    const result = (await recover(missing, { name: "TurretMid" }, async () => workspace)) as {
      nearestNames: string[];
      workspaceNames: string[];
    };

    // The script named it TurretMID; the level's part is PlinthMid. Neither is
    // guessable from the other, which is what cost the run several calls.
    expect(result.nearestNames[0]).toBe("TurretMID");
    // PlinthMid shares neither a prefix nor a substring with TurretMid — only the tail,
    // which is exactly what made the wrong name look right.
    expect(result.nearestNames).toContain("PlinthMid");
    expect(result.nearestNames).not.toContain("Lane");
  });

  test("still answers when the listing itself fails", async () => {
    const result = (await recover(missing, { name: "TurretMid" }, async () => {
      throw new Error("pieNotRunning");
    })) as Record<string, unknown>;

    expect(result.found).toBe(false);
    expect(result.workspaceNames).toBeUndefined();
  });

  test("rethrows anything that is not an absent instance", async () => {
    const other = new Error("Live instance state only exists while a play test runs.");
    await expect(recover(other, { name: "TurretMid" }, async () => workspace)).rejects.toThrow(/play test runs/);
  });
});
