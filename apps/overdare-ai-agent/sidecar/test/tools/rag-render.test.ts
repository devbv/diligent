// @summary Tests structured render payloads for OVERDARE RAG search tools.

import { describe, expect, test } from "bun:test";
import { buildSearchRender } from "../../src/tools/rag/render";

describe("buildSearchRender", () => {
  test("keeps asset search input metadata while rendering a lightweight gallery", () => {
    const assets = [
      {
        text: "A rusty katana model.",
        score: 0.87,
        title: "Katana, Rusty - 4",
        keywords: ["katana", "weapon"],
        assetId: "6584600",
        assetType: "MODEL",
        categoryId: "WEAPON",
        subCategoryId: "WEAPON_MELEE_WEAPONS",
        thumbnailUrl: "https://assets.example/katana.png",
      },
    ] as unknown as Parameters<typeof buildSearchRender>[1];
    const render = buildSearchRender({ source: "assets", query: "katana blade knife weapon" }, assets);

    expect(render.blocks.map((block) => block.type)).toEqual(["key_value", "asset_gallery"]);

    const inputBlock = render.blocks[0] as {
      type: string;
      title?: string;
      items: Array<{ key: string; value: string }>;
    };
    expect(inputBlock.type).toBe("key_value");
    expect(inputBlock.title).toBe("OVERDARE search");
    expect(inputBlock.items).toContainEqual({ key: "source", value: "assets" });
    expect(inputBlock.items).toContainEqual({ key: "query", value: "katana blade knife weapon" });
    expect(inputBlock.items).toContainEqual({ key: "results", value: "1" });

    const galleryBlock = render.blocks[1] as {
      type: string;
      title?: string;
      items: Array<{ metadata?: Array<{ key: string; value: string }> }>;
    };
    expect(galleryBlock.type).toBe("asset_gallery");
    expect(galleryBlock.title).toBe("OVERDARE Assets");
    expect(galleryBlock.items[0]).toMatchObject({
      id: "6584600",
      title: "Katana, Rusty - 4",
      subtitle: "MODEL",
      thumbnailUrl: "https://assets.example/katana.png",
    });
    expect(galleryBlock.items[0]?.metadata).toContainEqual({ key: "category", value: "WEAPON" });
  });
});
