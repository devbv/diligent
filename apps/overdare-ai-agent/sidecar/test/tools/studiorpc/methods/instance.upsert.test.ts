// @summary Tests class-bound validation for Studio RPC instance upserts.

import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../../../src/tools/studiorpc/methods/instance.upsert";

describe("instance.upsert class property validation", () => {
  test("rejects properties that belong to a different class", () => {
    expect(() =>
      parseArgs({
        items: [
          {
            class: "Part",
            parentGuid: "workspace",
            name: "NotATextLabel",
            properties: { Text: "invalid for Part" },
          },
        ],
      }),
    ).toThrow(/class=Part/);
  });

  test("accepts a partial update without injecting create defaults", () => {
    const parsed = parseArgs({
      items: [{ guid: "prompt", properties: { ActionText: "Open" } }],
    });

    expect(parsed.items[0]).toEqual({ guid: "prompt", properties: { ActionText: "Open" } });
  });
});
