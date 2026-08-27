// @summary Tests overdaresearch pack detection: includePacks request flag, synthetic
// pack picker option, and pack-selection enumeration returning the full member list.

import { afterEach, describe, expect, test } from "bun:test";
import type { UserInputRequest, UserInputResponse } from "@diligent/protocol";
import { createStudioBundledToolProviders } from "../../src/tools";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface RagPayload {
  results: unknown[];
  totalCount: number;
  packs?: Array<{ keyword: string; memberCount: number }>;
}

// Serves one queued payload per fetch call and records each request body.
function mockRagFetchSequence(payloads: RagPayload[]): { bodies: Record<string, unknown>[] } {
  const recorded: { bodies: Record<string, unknown>[] } = { bodies: [] };
  let call = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    recorded.bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    const payload = payloads[Math.min(call, payloads.length - 1)];
    call += 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return recorded;
}

const ctx = { toolCallId: "t", signal: new AbortController().signal, abort: () => {} };

function asset(id: string, title: string, keywords: string[] = [title]) {
  return {
    text: `${title} model`,
    score: 0.9,
    title,
    keywords,
    assetId: id,
    assetType: "MODEL",
    categoryId: "ENVIRONMENT",
    subCategoryId: "PROP",
    thumbnailUrl: `https://assets.example/${id}.png`,
    price: "100",
  };
}

async function searchTool(host: {
  approve?: () => Promise<"once">;
  ask?: (r: UserInputRequest) => Promise<UserInputResponse>;
}) {
  const providers = createStudioBundledToolProviders({ cwd: "/tmp/project" });
  const provider = providers.find((p) => p.id === "@overdare/rag-tools")!;
  const tools = await provider.createTools({ cwd: "/tmp/project", host });
  return tools.find((t) => t.name === "overdaresearch")!;
}

describe("overdaresearch pack detection", () => {
  test("assets+selectable request includes includePacks: true", async () => {
    const recorded = mockRagFetchSequence([
      { results: [asset("1", "Subway A"), asset("2", "Subway B")], totalCount: 2, packs: [] },
    ]);
    const tool = await searchTool({
      approve: async () => "once",
      ask: async (r) => ({ answers: { [r.questions[0].id]: "1" } }),
    });

    await tool.execute({ query: "subway", source: "assets", topK: 8, selectable: true }, ctx);

    expect(recorded.bodies[0].includePacks).toBe(true);
  });

  test("non-assets sources do not request includePacks", async () => {
    const recorded = mockRagFetchSequence([{ results: [], totalCount: 0 }]);
    const tool = await searchTool({ approve: async () => "once" });

    await tool.execute({ query: "subway", source: "docs", topK: 4 }, ctx);

    expect(recorded.bodies[0].includePacks).toBeUndefined();
  });

  test("detected pack appears as synthetic picker option with member count", async () => {
    mockRagFetchSequence([
      {
        results: [asset("1", "Prop_Subway_001"), asset("2", "Car 01", ["pack_metro", "car"])],
        totalCount: 2,
        packs: [{ keyword: "pack_metro", memberCount: 145 }],
      },
    ]);
    let seen: UserInputRequest | undefined;
    const tool = await searchTool({
      approve: async () => "once",
      ask: async (r) => {
        seen = r;
        return { answers: { [r.questions[0].id]: "1" } };
      },
    });

    const result = await tool.execute({ query: "subway", source: "assets", topK: 8, selectable: true }, ctx);

    const values = seen?.questions[0].options.map((o) => o.value) ?? [];
    // Pack options lead the list so they don't drown at the end of the grid.
    expect(values[0]).toBe("pack:pack_metro");
    const packOption = seen?.questions[0].options.find((o) => o.value === "pack:pack_metro");
    expect(packOption?.label).toContain("145");
    // No asset payload: the picker renders payload-less options as wide text rows.
    expect((packOption as { asset?: unknown })?.asset).toBeUndefined();
    // Choosing a normal asset still returns the single-asset result.
    expect(result.output).toContain("1");
  });

  test("choosing the pack enumerates members via assetFilter and returns the list", async () => {
    const recorded = mockRagFetchSequence([
      {
        results: [asset("1", "Prop_Subway_001"), asset("2", "Car 01", ["pack_metro", "car"])],
        totalCount: 2,
        packs: [{ keyword: "pack_metro", memberCount: 3 }],
      },
      {
        results: [
          asset("2", "Car 01", ["pack_metro", "car"]),
          asset("3", "Railroad 01", ["pack_metro", "rail"]),
          asset("4", "Pillar 01", ["pack_metro", "pillar"]),
        ],
        totalCount: 3,
      },
    ]);
    const tool = await searchTool({
      approve: async () => "once",
      ask: async (r) => ({ answers: { [r.questions[0].id]: "pack:pack_metro" } }),
    });

    const result = await tool.execute({ query: "subway", source: "assets", topK: 8, selectable: true }, ctx);

    // Second request is the enumeration call: assetFilter only, no query.
    const enumBody = recorded.bodies[1];
    expect(enumBody.assetFilter).toEqual({ keywords: ["pack_metro"] });
    expect(enumBody.query ?? "").toBe("");

    // Output carries the whole member list for the model to compose from.
    expect(result.output).toContain("pack_metro");
    for (const id of ["2", "3", "4"]) expect(result.output).toContain(id);
    expect(result.metadata?.packKeyword).toBe("pack_metro");
  });

  test("a single asset match still shows the picker when a pack was detected", async () => {
    mockRagFetchSequence([
      {
        results: [asset("2", "Car 01", ["pack_metro", "car"])],
        totalCount: 1,
        packs: [{ keyword: "pack_metro", memberCount: 145 }],
      },
    ]);
    let seen: UserInputRequest | undefined;
    const tool = await searchTool({
      approve: async () => "once",
      ask: async (r) => {
        seen = r;
        return { answers: { [r.questions[0].id]: "2" } };
      },
    });

    const result = await tool.execute({ query: "metro car", source: "assets", topK: 8, selectable: true }, ctx);

    const values = seen?.questions[0].options.map((o) => o.value) ?? [];
    expect(values).toEqual(["pack:pack_metro", "2"]);
    expect(result.output).toContain("2");
  });

  test("zero visible results with a detected pack still shows the picker", async () => {
    // The pack scan uses a lower score floor than the visible results, so the
    // pack can be the only answer.
    const recorded = mockRagFetchSequence([
      { results: [], totalCount: 0, packs: [{ keyword: "pack_metro", memberCount: 145 }] },
      {
        results: [asset("2", "Car 01", ["pack_metro", "car"])],
        totalCount: 1,
      },
    ]);
    let seen: UserInputRequest | undefined;
    const tool = await searchTool({
      approve: async () => "once",
      ask: async (r) => {
        seen = r;
        return { answers: { [r.questions[0].id]: "pack:pack_metro" } };
      },
    });

    const result = await tool.execute(
      { query: "underground station", source: "assets", topK: 8, selectable: true },
      ctx,
    );

    expect(seen?.questions[0].options.map((o) => o.value)).toEqual(["pack:pack_metro"]);
    expect(recorded.bodies[1].assetFilter).toEqual({ keywords: ["pack_metro"] });
    expect(result.metadata?.packKeyword).toBe("pack_metro");
  });

  test("zero results and zero packs still returns not-found", async () => {
    mockRagFetchSequence([{ results: [], totalCount: 0, packs: [] }]);
    let asked = false;
    const tool = await searchTool({
      approve: async () => "once",
      ask: async () => {
        asked = true;
        return { answers: {} };
      },
    });

    const result = await tool.execute({ query: "nothing", source: "assets", topK: 8, selectable: true }, ctx);

    expect(asked).toBe(false);
    expect(result.output).toBe("No results found.");
  });

  test("a single asset match with no pack still auto-selects", async () => {
    mockRagFetchSequence([{ results: [asset("2", "Car 01")], totalCount: 1, packs: [] }]);
    let asked = false;
    const tool = await searchTool({
      approve: async () => "once",
      ask: async () => {
        asked = true;
        return { answers: {} };
      },
    });

    const result = await tool.execute({ query: "metro car", source: "assets", topK: 8, selectable: true }, ctx);

    expect(asked).toBe(false);
    expect(result.output).toContain("2");
  });
});
