// @summary Tests user-input schema asset-picker extensions (value/asset/display) and backward compatibility.

import { describe, expect, test } from "bun:test";
import { UserInputRequestSchema } from "../src/data-model";

describe("UserInputRequestSchema asset picker fields", () => {
  test("parses asset options with value/asset and the display hint", () => {
    const parsed = UserInputRequestSchema.parse({
      questions: [
        {
          id: "asset",
          header: "Asset",
          question: 'Pick an asset for "katana"',
          display: "asset",
          options: [
            {
              label: "Katana, Rusty",
              description: "MODEL",
              value: "6584600",
              asset: { thumbnailUrl: "https://assets.example/k.png", price: "100" },
            },
          ],
        },
      ],
    });

    expect(parsed.questions[0].display).toBe("asset");
    expect(parsed.questions[0].options[0].value).toBe("6584600");
    expect(parsed.questions[0].options[0].asset?.thumbnailUrl).toBe("https://assets.example/k.png");
  });

  test("still parses legacy text options without the new fields", () => {
    const parsed = UserInputRequestSchema.parse({
      questions: [{ id: "q1", header: "Q", question: "Pick", options: [{ label: "A", description: "a" }] }],
    });

    expect(parsed.questions[0].options[0].value).toBeUndefined();
    expect(parsed.questions[0].display).toBeUndefined();
  });
});
