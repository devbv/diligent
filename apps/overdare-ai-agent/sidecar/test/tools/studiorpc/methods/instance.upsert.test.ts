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

  test("accepts FontFace on text classes and rejects the removed Bold property", () => {
    const parsed = parseArgs({
      items: [
        {
          class: "TextLabel",
          parentGuid: "screen",
          name: "Title",
          properties: { Text: "Hi", FontFace: { Family: "Default", Weight: "Bold" } },
        },
      ],
    });
    expect(parsed.items[0].properties?.FontFace).toEqual({ Family: "Default", Weight: "Bold" });

    expect(() =>
      parseArgs({
        items: [
          {
            class: "TextButton",
            parentGuid: "screen",
            name: "Btn",
            properties: { Text: "Hi", Bold: true },
          },
        ],
      }),
    ).toThrow(/class=TextButton/);
  });

  test("accepts 9-slice properties on image classes", () => {
    for (const cls of ["ImageButton", "ImageLabel"] as const) {
      const parsed = parseArgs({
        items: [
          {
            class: cls,
            parentGuid: "screen",
            name: "Panel",
            properties: {
              ScaleType: "Slice",
              SliceCenter: { Min: { X: 10, Y: 10 }, Max: { X: 90, Y: 90 } },
              SliceScale: 1.5,
            },
          },
        ],
      });
      expect(parsed.items[0].properties?.ScaleType).toBe("Slice");
    }
  });
});
