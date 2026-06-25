import type { ToolContext, ToolResult } from "@diligent/core/tool/types";
import { type RuntimeToolHost, requestToolApproval, requestToolUserInput } from "@diligent/runtime";
import { z } from "zod";
import { buildSearchRender, normalizeAssetForRender } from "./render";

const BASE_URL = "https://aiguide.overdare.com";
const TIMEOUT_MS = 10_000;

interface RagResult {
  text: string;
  originFileUrl?: string;
  script?: string;
}

interface AssetResult {
  text: string;
  score: number;
  title: string;
  keywords: string[];
  assetId: string;
  assetType: string;
  categoryId: string;
  subCategoryId: string;
}

interface RagResponse {
  results: Array<RagResult | AssetResult>;
  totalCount: number;
}

function isAssetResult(result: RagResult | AssetResult): result is AssetResult {
  return "assetId" in result;
}

function normalizeAssetResult(result: Partial<AssetResult>): Partial<AssetResult> {
  return {
    text: result.text,
    score: result.score,
    title: result.title,
    keywords: result.keywords,
    assetId: result.assetId,
    assetType: result.assetType,
    categoryId: result.categoryId,
    subCategoryId: result.subCategoryId,
  };
}

export const name = "overdaresearch";

export const description = `Searches OVERDARE documentation, code examples, and assets using RAG.
Use this tool to find relevant OVERDARE API references, guides, code examples, Lua scripts, and asset metadata.

When to use each source:
  - Default topK by source: docs=4, code=4, assets=8; only increase if results are insufficient
  - "docs": API references, conceptual guides, configuration details, service descriptions
  - "code": Working Lua implementation examples, proven patterns, real script snippets
  - "assets": Asset catalog search returning asset metadata such as title, keywords, assetId, assetType, categoryId, and subCategoryId
  - When writing or modifying code, search BOTH docs and code in parallel (two calls: one for docs, one for code) to get API shape + implementation patterns simultaneously

Query tips:
  - Provide a clear, specific RAG-friendly query describing what you want to find
  - Never include "OVERDARE" in query — all content is already scoped to OVERDARE
  - When querying for docs, do not include keywords like "doc" or "documentation" in the query — the source already targets the documentation store
  - When querying for code, do not include keywords like "Lua", "example", or "script" in the query — the source already targets the Lua code store
  - When querying for assets, use short noun-based queries such as item names, themes, categories, or use cases`;

export const parameters = z.object({
  query: z.string().describe("Search query for OVERDARE (English only)"),
  source: z
    .enum(["docs", "code", "assets"])
    .describe(
      "docs = API references and guides. code = working Lua implementation examples and patterns. assets = asset catalog search with asset metadata fields.",
    ),
  topK: z.number().int().min(1).max(10).describe("Number of results to return"),
  selectable: z
    .boolean()
    .optional()
    .describe(
      "Assets only. When true and 2+ assets match, ask the user to pick one and return the chosen assetId; exactly 1 match auto-selects; 0 matches returns not-found. Use when the user should choose a specific asset.",
    ),
});

type Params = z.infer<typeof parameters>;

async function selectAsset(
  host: RuntimeToolHost | undefined,
  query: string,
  rawAssets: Array<Partial<AssetResult>>,
): Promise<string> {
  const normalized = rawAssets.map(normalizeAssetForRender);
  const response = await requestToolUserInput(host, {
    questions: [
      {
        id: "asset",
        header: "Asset",
        question: `Pick an asset for "${query}"`,
        display: "asset",
        options: normalized.map((a) => ({
          label: a.title,
          description: a.price ? `${a.assetType} · ${a.price}` : a.assetType,
          value: a.assetId,
          asset: {
            thumbnailUrl: a.thumbnailUrl,
            previewUrl: a.previewUrl,
            price: a.price,
            subtitle: a.assetType,
          },
        })),
      },
    ],
  });

  const answer = response?.answers.asset;
  const chosen = Array.isArray(answer) ? answer[0] : answer;
  if (!chosen || chosen.trim().length === 0) {
    return "[Cancelled by user]";
  }
  const match = normalized.find((a) => a.assetId === chosen);
  return match ? `Selected asset: ${match.title} (assetId: ${match.assetId})` : `Selected assetId: ${chosen}`;
}

export async function execute(args: Params, _ctx: ToolContext, host?: RuntimeToolHost): Promise<ToolResult> {
  const approval = await requestToolApproval(host, {
    permission: "execute",
    toolName: name,
    description: `OVERDARE RAG search [${args.source}]: ${args.query}`,
    details: { query: args.query, source: args.source, topK: args.topK },
  });
  if (approval === "reject") {
    return { output: "[Rejected by user]", metadata: { error: true } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}/api/chat/rag`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: args.query,
        version: "3",
        source: args.source,
        topK: args.topK ?? 4,
        threshold: 0.5,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      let errMsg = errText.substring(0, 200);
      try {
        const errJson = JSON.parse(errText) as { error?: string };
        if (errJson?.error) errMsg = errJson.error.substring(0, 200);
      } catch {
        // ignore parse error, use raw text
      }
      throw new Error(`OVERDARE RAG search failed (HTTP ${response.status}): ${errMsg}`);
    }

    const data = (await response.json()) as RagResponse;
    const results = (data?.results ?? []).filter((result) => {
      if ((result.text ?? "").length > 0) return true;
      if ("script" in result && ((result as RagResult).script ?? "").length > 0) return true;
      return false;
    });

    if (args.source === "assets") {
      const rawAssets = results.filter(isAssetResult);
      const assetResults = rawAssets.map(normalizeAssetResult);

      if (args.selectable) {
        if (rawAssets.length === 0) {
          return { output: "No results found.", metadata: { resultCount: 0 } };
        }
        if (rawAssets.length === 1) {
          const only = normalizeAssetForRender(rawAssets[0]);
          return {
            output: `Selected asset: ${only.title} (assetId: ${only.assetId})`,
            metadata: { resultCount: 1, assetId: only.assetId },
          };
        }
        const output = await selectAsset(host, args.query, rawAssets);
        return { output, metadata: { resultCount: rawAssets.length } };
      }

      return {
        output: assetResults.length
          ? JSON.stringify({ results: assetResults, totalCount: data?.totalCount ?? assetResults.length }, null, 2)
          : "No results found.",
        render: buildSearchRender({ source: args.source, query: args.query }, rawAssets),
        metadata: { resultCount: assetResults.length, results: assetResults },
      };
    }

    const ragResults = results.filter((result): result is RagResult => !isAssetResult(result));

    return {
      output: ragResults.length ? JSON.stringify(ragResults, null, 2) : "No results found.",
      render: buildSearchRender({ source: args.source, query: args.query }, ragResults),
      metadata: { resultCount: ragResults.length, results: ragResults },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("OVERDARE RAG search timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
