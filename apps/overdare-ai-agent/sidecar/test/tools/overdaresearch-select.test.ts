// @summary Tests overdaresearch selectable asset flow: 0/1/many result branches and answer→assetId mapping.

import { afterEach, describe, expect, test } from "bun:test";
import type { UserInputRequest, UserInputResponse } from "@diligent/protocol";
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

function asset(id: string, title: string) {
  return {
    text: `${title} model`,
    score: 0.9,
    title,
    keywords: [title],
    assetId: id,
    assetType: "MODEL",
    categoryId: "WEAPON",
    subCategoryId: "WEAPON_MELEE",
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

describe("overdaresearch selectable", () => {
  test("default (selectable omitted): parsed args default to true and still prompt for 2+ assets", async () => {
    mockRagFetch([asset("111", "Katana A"), asset("222", "Katana B")]);
    let asked = false;
    const tool = await searchTool({
      approve: async () => "once",
      ask: async (r) => {
        asked = true;
        return { answers: { [r.questions[0].id]: "111" } };
      },
    });

    // The runtime parses tool args against the schema before execute, applying defaults.
    const args = tool.parameters.parse({ query: "katana", source: "assets", topK: 8 });
    expect(args.selectable).toBe(true);

    const result = await tool.execute(args, ctx);
    expect(asked).toBe(true);
    expect(result.output).toContain("111");
  });

  test("many results: asks the user and returns the chosen assetId", async () => {
    mockRagFetch([asset("111", "Katana A"), asset("222", "Katana B")]);
    let seen: UserInputRequest | undefined;
    const tool = await searchTool({
      approve: async () => "once",
      ask: async (r) => {
        seen = r;
        return { answers: { [r.questions[0].id]: "222" } };
      },
    });

    const result = await tool.execute({ query: "katana", source: "assets", topK: 8, selectable: true }, ctx);

    expect(seen?.questions[0].display).toBe("asset");
    expect(seen?.questions[0].options.map((o) => o.value)).toEqual(["111", "222"]);
    expect(seen?.questions[0].options[0].asset?.thumbnailUrl).toBe("https://assets.example/111.png");
    expect(result.output).toContain("222");
  });

  test("single result: auto-selects without asking", async () => {
    mockRagFetch([asset("333", "Only Katana")]);
    let asked = false;
    const tool = await searchTool({
      approve: async () => "once",
      ask: async () => {
        asked = true;
        return { answers: {} };
      },
    });

    const result = await tool.execute({ query: "katana", source: "assets", topK: 8, selectable: true }, ctx);

    expect(asked).toBe(false);
    expect(result.output).toContain("333");
  });

  test("no results: returns not-found without asking", async () => {
    mockRagFetch([]);
    let asked = false;
    const tool = await searchTool({
      approve: async () => "once",
      ask: async () => {
        asked = true;
        return { answers: {} };
      },
    });

    const result = await tool.execute({ query: "katana", source: "assets", topK: 8, selectable: true }, ctx);

    expect(asked).toBe(false);
    expect(result.output).toBe("No results found.");
  });
});
