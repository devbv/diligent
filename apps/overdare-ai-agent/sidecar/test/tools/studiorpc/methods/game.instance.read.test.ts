// @summary Tests that the live instance read accepts the GUID name its sibling tool uses.
import { describe, expect, test } from "bun:test";
import { normalizeArgs, params } from "../../../../src/tools/studiorpc/methods/game.instance.read";

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
