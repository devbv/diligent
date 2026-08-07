// @summary Tests overdaresearch vfx source: docType-discriminated results, no asset picker, render payload.

import { afterEach, describe, expect, test } from "bun:test";
import { createStudioBundledToolProviders } from "../../src/tools";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockRagFetch(results: unknown[]): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ results, totalCount: results.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

const ctx = { toolCallId: "t", signal: new AbortController().signal, abort: () => {} };

async function searchTool(host: { approve?: () => Promise<"once">; ask?: () => Promise<never> }) {
  const providers = createStudioBundledToolProviders({ cwd: "/tmp/project" });
  const provider = providers.find((p) => p.id === "@overdare/rag-tools")!;
  const tools = await provider.createTools({ cwd: "/tmp/project", host });
  return tools.find((t) => t.name === "overdaresearch")!;
}

const comboResult = {
  text: "# COMBO_01 · Green Acid Liquid + Smoke Composite Burst\n…Original Payload JSON…",
  score: 0.91,
  title: "Green Acid Liquid + Smoke Composite Burst (combo_01)",
  docType: "recipe_combo",
  docId: "combo_01_en",
  keywords: ["liquid", "smoke", "burst"],
  category: "impact_burst",
  elements: ["liquid", "smoke", "fire"],
  sources: ["LiquidFlash_A", "SmokeBurst_A"],
  patterns: ["multi_base"],
};

const sourceResult = {
  text: "## Fire Rise A\nSpawnType: burst…User Parameters…",
  score: 0.84,
  title: "FireRise_A (Base)",
  docType: "vfx_source",
  docId: "vfxsource_FireRise_A",
  keywords: ["fire", "rising"],
  layer: "Base",
  spawnType: "burst",
  element: "fire",
  resourceName: "FireRise_A",
};

describe("overdaresearch vfx source", () => {
  test("returns docType-discriminated results as JSON without asking the user", async () => {
    mockRagFetch([comboResult, sourceResult]);
    let asked = false;
    const tool = await searchTool({
      approve: async () => "once",
      ask: async () => {
        asked = true;
        throw new Error("vfx source must not open the asset picker");
      },
    });

    const args = tool.parameters.parse({ query: "acid liquid smoke burst", source: "vfx", topK: 3 });
    const result = await tool.execute(args, ctx);

    expect(asked).toBe(false);
    const parsed = JSON.parse(result.output) as { results: Record<string, unknown>[]; totalCount: number };
    expect(parsed.totalCount).toBe(2);
    expect(parsed.results[0].docType).toBe("recipe_combo");
    expect(parsed.results[0].sources).toEqual(["LiquidFlash_A", "SmokeBurst_A"]);
    expect(parsed.results[1].docType).toBe("vfx_source");
    expect(parsed.results[1].resourceName).toBe("FireRise_A");
    expect(result.render).toBeDefined();
    expect(result.metadata?.resultCount).toBe(2);
  });

  test("returns not-found output when no vfx results match", async () => {
    mockRagFetch([]);
    const tool = await searchTool({ approve: async () => "once" });

    const result = await tool.execute({ query: "nonexistent", source: "vfx", topK: 3, selectable: true }, ctx);

    expect(result.output).toBe("No results found.");
    expect(result.metadata?.resultCount).toBe(0);
  });
});
