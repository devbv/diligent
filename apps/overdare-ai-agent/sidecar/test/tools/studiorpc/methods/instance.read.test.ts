// @summary Tests that instance.read accepts the GUID field name the other tools report.
import { describe, expect, test } from "bun:test";
import { normalizeArgs, params } from "../../../../src/tools/studiorpc/methods/instance.read";

describe("instance.read arguments", () => {
  test("accepts instanceGuid, the name every tool that reports a GUID uses", () => {
    const parsed = params.parse(normalizeArgs({ instanceGuid: "5014F114A64A34D0695EB0D7CEDD7F17" }));

    expect(parsed.guid).toBe("5014F114A64A34D0695EB0D7CEDD7F17");
  });

  test("leaves guid alone when it is already given", () => {
    const parsed = params.parse(normalizeArgs({ guid: "AAA", instanceGuid: "BBB" }));

    expect(parsed.guid).toBe("AAA");
  });

  test("still rejects a call that names no instance at all", () => {
    expect(() => params.parse(normalizeArgs({ recursive: true }))).toThrow();
  });
});
