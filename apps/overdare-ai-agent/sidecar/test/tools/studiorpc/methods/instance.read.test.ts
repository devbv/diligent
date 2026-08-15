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

  test("lets a call with no instance through the schema, to be refused in words", () => {
    // Three testers called this with no arguments expecting the live tool's listing.
    // The validator's "guid: Required" named a field they thought they had left out on
    // purpose; the tool itself now answers with which tool they actually wanted, so the
    // schema deliberately stops rejecting it first.
    expect(() => params.parse(normalizeArgs({ recursive: true }))).not.toThrow();
    expect(params.parse(normalizeArgs({ recursive: true })).guid).toBeUndefined();
  });
});
